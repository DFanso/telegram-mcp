// Menu bar companion for the telegram-mcp daemon.
// Shows approvals (approve / deny), which Claude sessions are listening to which chats,
// and the chats you last sent to (click a chat to see what was sent). The Contacts page lists the
// saved chats and edits their nickname, sending rule and auto-reply in config.json.
// Talks only to the local daemon on 127.0.0.1, authenticated with the token the daemon keeps in
// the login Keychain (service "telegram-mcp"; a file instead with TELEGRAM_MCP_SECRET_STORE=file).

import AppKit
import AVFoundation
import Security
import SwiftUI
import UserNotifications

// MARK: - What the daemon sends (GET /ui/state)

struct TelegramState: Decodable {
    let phase: String
    let me: Peer?
    let lastError: String?
    let reconnects: Int
}

struct Peer: Decodable {
    let id: Int
    let name: String
    let username: String?
}

struct WatchSpec: Decodable, Identifiable {
    let id: String
    let chatId: Int
    let chatLabel: String
    let fromLabel: String?
    let topicId: Int?
    let note: String?
}

struct UiSession: Decodable, Identifiable {
    let id: String
    let label: String
    let connected: Bool
    let channel: Bool
    let monitors: Int
    let pending: Int
    let watches: [WatchSpec]
}

struct UiApproval: Decodable, Identifiable {
    let id: String
    let to: String
    let detail: String
    let text: String
    let reason: String
    let sessionLabel: String
    let createdAt: String
    let expiresAt: String
    let firstTime: Bool
    let nickname: String?
    let suggestedNickname: String
}

struct SentRecord: Decodable, Identifiable {
    var id: String { "\(chatId):\(messageId)" }
    let at: String
    let chatId: Int
    let chatLabel: String
    let text: String
    let messageId: Int
    let via: String
    let sessionLabel: String?
}

/// A saved chat and the rules that apply to it (the Contacts page).
struct UiContact: Decodable, Identifiable {
    var id: String { nickname }
    let nickname: String
    let chatId: Int
    let name: String?
    let username: String?
    let type: String?
    let topicId: Int?
    let aliases: [String]
    let notes: String?
    /// "autoSend" | "requireApproval" | "blocked" | "none"
    let sendMode: String
    let autoReply: Bool
    let policy: String
    let sameChat: [String]
    /// A person other than you, so paging works both ways. Missing from a daemon older than this app.
    let pageable: Bool?
    /// On paging.pageFrom: their "/page <reason>" rings you.
    let pageFrom: Bool?

    var canPage: Bool { pageable ?? false }
    var pagesMe: Bool { pageFrom ?? false }
}

/// A page: something that needs you now. Rings until you ack or snooze it here, in the tray or on the phone.
struct UiPage: Decodable, Identifiable, Equatable {
    let id: String
    /// "command" | "keyword" | "claude" | "test"
    let source: String
    /// "ringing" | "unanswered" | "snoozed"
    let state: String
    let from: String
    let chat: String?
    let chatId: Int?
    let messageId: Int?
    let reason: String
    let createdAt: String
    let snoozedUntil: String?

    var ringing: Bool { state != "snoozed" }

    /// Opens the message in Telegram: users by id, supergroups through t.me/c, basic groups by chat id.
    var messageURL: URL? {
        guard let chatId, let messageId else { return nil }
        if chatId > 0 { return URL(string: "tg://openmessage?user_id=\(chatId)&message_id=\(messageId)") }
        if chatId <= -1_000_000_000_000 { return URL(string: "https://t.me/c/\(-chatId - 1_000_000_000_000)/\(messageId)") }
        return URL(string: "tg://openmessage?chat_id=\(-chatId)&message_id=\(messageId)")
    }
}

struct UiState: Decodable {
    let telegram: TelegramState
    let configError: String?
    let footer: String
    let approvals: [UiApproval]
    let sessions: [UiSession]
    let recent: [SentRecord]
    /// Missing from a daemon older than this app; the Contacts page then asks for a restart.
    let contacts: [UiContact]?
    let defaultPolicy: String?
    /// Missing from a daemon older than this app.
    let pages: [UiPage]?
}

/// The chats you last sent to, newest first, each with the messages sent there.
struct RecentChat: Identifiable {
    let id: Int
    let label: String
    let messages: [SentRecord]
}

// MARK: - Talking to the daemon

/// Reads the daemon's token. Mirrors src/shared/secrets.ts: service "telegram-mcp", account
/// "token" for the default home and "token@<home>" for any other TELEGRAM_MCP_HOME.
enum TokenSource {
    struct Result: Sendable {
        let token: String?
        let status: OSStatus
    }

    static var usesFile: Bool {
        ProcessInfo.processInfo.environment["TELEGRAM_MCP_SECRET_STORE"]?.lowercased() == "file"
    }

    static func account(home: URL) -> String {
        let defaultHome = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/telegram-mcp")
        return home.path == defaultHome.path ? "token" : "token@\(home.path)"
    }

    /// Blocks while macOS asks "allow access?" the first time, so call it off the main thread.
    static func read(home: URL) -> Result {
        if usesFile {
            let t = (try? String(contentsOf: home.appendingPathComponent("token"), encoding: .utf8))?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return Result(token: t?.isEmpty == false ? t : nil, status: t == nil ? errSecItemNotFound : errSecSuccess)
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "telegram-mcp",
            kSecAttrAccount as String: account(home: home),
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        guard status == errSecSuccess, let data = out as? Data, let t = String(data: data, encoding: .utf8) else {
            return Result(token: nil, status: status == errSecSuccess ? errSecDecode : status)
        }
        let token = t.trimmingCharacters(in: .whitespacesAndNewlines)
        return Result(token: token.isEmpty ? nil : token, status: status)
    }

    static func problem(_ status: OSStatus) -> String {
        switch status {
        case errSecItemNotFound:
            return "No token yet. Is the daemon installed? (tgmcp install)"
        case errSecUserCanceled, errSecAuthFailed:
            return "Keychain access was denied. Quit and reopen the app, then choose Always Allow."
        case errSecInteractionNotAllowed:
            return "The Keychain is locked. Unlock it (log in) and this retries by itself."
        default:
            let why = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
            return "Could not read the token from the Keychain: \(why)"
        }
    }
}

@MainActor
final class Store: ObservableObject {
    @Published var state: UiState?
    @Published var reachable = false
    @Published var problem: String?
    @Published var busy: Set<String> = []
    @Published var flash: String?
    @Published var pages: [UiPage] = []
    private let alarm = PageAlarm()

    let home: URL
    let port: Int
    private var timer: Timer?
    private var notified = Set<String>()

    init(polling: Bool = true) {
        let env = ProcessInfo.processInfo.environment
        if let h = env["TELEGRAM_MCP_HOME"], !h.isEmpty {
            home = URL(fileURLWithPath: h)
        } else {
            home = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/telegram-mcp")
        }
        port = Int(env["TELEGRAM_MCP_PORT"] ?? "") ?? 47823
        guard polling else { return }
        let t = Timer(timeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.poll() }
        }
        RunLoop.main.add(t, forMode: .common) // keep polling while the panel is open
        timer = t
        Task { await poll() }
    }

    /// Read once and kept in memory. Cleared when the daemon says no, so a new token is picked up.
    private var token: String?
    private var tokenProblem: String?
    private var readingToken = false
    private var tokenRetryAt = Date.distantPast

    private func currentToken() async -> String? {
        if let token { return token }
        // One read at a time, and after a "Deny" wait a minute: a prompt every 2 s would be awful.
        guard !readingToken, Date() >= tokenRetryAt else { return nil }
        readingToken = true
        defer { readingToken = false }
        let home = self.home
        let result = await Task.detached { TokenSource.read(home: home) }.value
        if let t = result.token {
            token = t
            tokenProblem = nil
            return t
        }
        tokenProblem = TokenSource.problem(result.status)
        tokenRetryAt = Date().addingTimeInterval(result.status == errSecItemNotFound ? 2 : 60)
        return nil
    }

    private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) async -> URLRequest? {
        guard let token = await currentToken(), let url = URL(string: "http://127.0.0.1:\(port)\(path)") else { return nil }
        var req = URLRequest(url: url, timeoutInterval: 4)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        return req
    }

    func poll() async {
        guard let req = await request("/ui/state") else {
            reachable = false
            problem = tokenProblem ?? "Reading the token from the Keychain…"
            return
        }
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode
            guard code == 200 else {
                if code == 401 { token = nil } // the token changed: read it again next time
                reachable = false
                problem = "The daemon refused the request (token mismatch?)."
                return
            }
            let next = try JSONDecoder().decode(UiState.self, from: data)
            state = next
            reachable = true
            problem = nil
            notifyNewApprovals(next.approvals)
            showPages(next.pages ?? [])
        } catch {
            reachable = false
            problem = "The daemon is not running. It restarts by itself; or run tgmcp install."
        }
    }

    private func showPages(_ next: [UiPage]) {
        if next != pages { pages = next }
        alarm.update(ringing: next.filter(\.ringing), store: self)
    }

    /// Ack, or snooze for `minutes` (15 or 60). Stops the alarm here at once; the daemon tells the rest.
    func page(_ id: String, ack: Bool, minutes: Int = 15) async {
        var body: [String: Any] = ["action": ack ? "ack" : "snooze", "from": "menubar"]
        if !ack { body["minutes"] = minutes }
        guard let req = await request("/ui/pages/\(id)", method: "POST", body: body) else {
            show(tokenProblem ?? "No token for the daemon yet.")
            return
        }
        showPages(pages.filter { $0.id != id })
        do {
            _ = try await URLSession.shared.data(for: req)
        } catch {
            show("Could not reach the daemon: \(error.localizedDescription)")
        }
        await poll()
    }

    /// `remember` (first message to a chat): "autoSend" = always allow, "requireApproval" = ask every time.
    func decide(_ id: String, approve: Bool, remember: String? = nil, nickname: String? = nil) async {
        var body = ["decision": approve ? "approve" : "deny"]
        if let remember { body["remember"] = remember }
        if let nickname, !nickname.trimmingCharacters(in: .whitespaces).isEmpty { body["nickname"] = nickname }
        guard let req = await request("/ui/approvals/\(id)", method: "POST", body: body) else {
            show(tokenProblem ?? "No token for the daemon yet.")
            return
        }
        busy.insert(id)
        defer { busy.remove(id) }
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            show((obj?["text"] as? String) ?? (approve ? "Approved." : "Denied."))
        } catch {
            show("Could not reach the daemon: \(error.localizedDescription)")
        }
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [id])
        await poll()
    }

    /// A Contacts-page edit: "sendMode", "autoReply" and/or "rename". Returns the chat's nickname
    /// afterwards (a rename changes it), or nil when it wasn't saved.
    @discardableResult
    func editContact(_ nickname: String, _ change: [String: Any]) async -> String? {
        var body = change
        body["nickname"] = nickname
        guard let req = await request("/ui/contacts", method: "POST", body: body) else {
            show(tokenProblem ?? "No token for the daemon yet.")
            return nil
        }
        let key = "contact:\(nickname)"
        busy.insert(key)
        defer { busy.remove(key) }
        var saved: String?
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            if code == 404 {
                show("The daemon is older than this app. Restart it (below) to edit contacts.")
            } else {
                show((obj?["text"] as? String) ?? (code == 200 ? "Saved." : "Not changed."))
                if code == 200 { saved = (obj?["nickname"] as? String) ?? nickname }
            }
        } catch {
            show("Could not reach the daemon: \(error.localizedDescription)")
        }
        await poll()
        return saved
    }

    /// The Page button: the daemon sends "/page <reason>" to that person. True when it went out.
    @discardableResult
    func pageContact(_ nickname: String, reason: String) async -> Bool {
        guard let req = await request("/ui/contacts/page", method: "POST", body: ["nickname": nickname, "reason": reason]) else {
            show(tokenProblem ?? "No token for the daemon yet.")
            return false
        }
        let key = "page:\(nickname)"
        busy.insert(key)
        defer { busy.remove(key) }
        var sent = false
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            if code == 404 {
                show("The daemon is older than this app. Restart it (below) to page from here.")
            } else {
                sent = code == 200
                show((obj?["text"] as? String) ?? (sent ? "Paged." : "Not paged."))
            }
        } catch {
            show("Could not reach the daemon: \(error.localizedDescription)")
        }
        await poll()
        return sent
    }

    private func show(_ text: String) {
        flash = text
        Task {
            try? await Task.sleep(for: .seconds(6))
            if flash == text { flash = nil }
        }
    }

    private func notifyNewApprovals(_ approvals: [UiApproval]) {
        let ids = Set(approvals.map(\.id))
        let center = UNUserNotificationCenter.current()
        let gone = notified.subtracting(ids)
        if !gone.isEmpty { center.removeDeliveredNotifications(withIdentifiers: Array(gone)) }
        for a in approvals where !notified.contains(a.id) {
            let content = UNMutableNotificationContent()
            content.title = "Approve Telegram message?"
            content.subtitle = "To \(a.to) (\(a.detail))"
            content.body = a.text
            content.categoryIdentifier = a.firstTime ? "APPROVAL_NEW" : "APPROVAL"
            if a.firstTime { content.title = "First message to \(a.to): approve?" }
            content.userInfo = ["approvalId": a.id]
            content.sound = .default
            center.add(UNNotificationRequest(identifier: a.id, content: content, trigger: nil))
        }
        notified = ids
    }

    var recentChats: [RecentChat] {
        var order: [Int] = []
        var byChat: [Int: [SentRecord]] = [:]
        for r in state?.recent ?? [] {
            if byChat[r.chatId] == nil { order.append(r.chatId) }
            byChat[r.chatId, default: []].append(r)
        }
        return order.prefix(5).map { id in
            RecentChat(id: id, label: byChat[id]!.first!.chatLabel, messages: byChat[id]!)
        }
    }

    /// The message without the footer, for the recent list (approval cards show the exact text).
    func body(_ text: String) -> String {
        let mark = (state?.footer ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !mark.isEmpty, t.hasSuffix(mark) else { return t }
        return String(t.dropLast(mark.count)).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var listening: [UiSession] { (state?.sessions ?? []).filter { !$0.watches.isEmpty } }

    func openFile(_ name: String) {
        NSWorkspace.shared.open(home.appendingPathComponent(name))
    }

    func restartDaemon() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = ["kickstart", "-k", "gui/\(getuid())/com.telegram-mcp.daemon"]
        try? p.run()
        show("Restarting the daemon…")
    }
}

// MARK: - Notification actions (approve / deny straight from the banner)

final class NotificationHandler: NSObject, UNUserNotificationCenterDelegate {
    weak var store: Store?

    func setUp(store: Store) {
        self.store = store
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let approve = UNNotificationAction(identifier: "APPROVE", title: "Approve", options: [])
        let deny = UNNotificationAction(identifier: "DENY", title: "Deny", options: [.destructive])
        let askNext = UNNotificationAction(identifier: "APPROVE", title: "Approve, ask next time", options: [])
        let always = UNNotificationAction(identifier: "ALWAYS", title: "Approve, always allow", options: [])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "APPROVAL", actions: [approve, deny], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: "APPROVAL_NEW", actions: [askNext, always, deny], intentIdentifiers: [], options: []),
        ])
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        let id = response.notification.request.content.userInfo["approvalId"] as? String
        let action = response.actionIdentifier
        Task { @MainActor in
            if let id, action == "APPROVE" { await self.store?.decide(id, approve: true, remember: "requireApproval") }
            if let id, action == "ALWAYS" { await self.store?.decide(id, approve: true, remember: "autoSend") }
            if let id, action == "DENY" { await self.store?.decide(id, approve: false) }
            done()
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .list, .sound])
    }
}

// MARK: - Helpers

let isSnapshot = CommandLine.arguments.contains("--snapshot")
/// `SNAPSHOT_EXPAND=1` starts approval cards and recent chats expanded, as if clicked open;
/// `approvals` or `recent` expands only that section. (`SNAPSHOT_HOVER` is its old name.)
let snapshotExpandMode = ProcessInfo.processInfo.environment["SNAPSHOT_EXPAND"]
    ?? ProcessInfo.processInfo.environment["SNAPSHOT_HOVER"] ?? ""
let snapshotExpandApprovals = ["1", "approvals"].contains(snapshotExpandMode)
let snapshotExpandRecent = ["1", "recent"].contains(snapshotExpandMode)

/// Whether a draft runs past the 4 lines an approval card shows (about 55 characters a line), so
/// the card offers Show all. Nothing in the panel opens on hover: hovering past it shouldn't
/// make the panel jump.
func isLongDraft(_ text: String) -> Bool {
    text.split(separator: "\n", omittingEmptySubsequences: false)
        .reduce(0) { $0 + max(1, ($1.count + 54) / 55) } > 4
}
/// `SNAPSHOT_PAGE=contacts` renders the Contacts page; `SNAPSHOT_OPEN=<nickname>` opens that contact.
let snapshotContacts = ProcessInfo.processInfo.environment["SNAPSHOT_PAGE"] == "contacts"
let snapshotOpenContact = ProcessInfo.processInfo.environment["SNAPSHOT_OPEN"]

private let isoWithFraction: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

func ago(_ iso: String) -> String {
    guard let date = isoWithFraction.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return "" }
    let s = Int(-date.timeIntervalSinceNow)
    if s < 60 { return "now" }
    if s < 3600 { return "\(s / 60)m" }
    if s < 86400 { return "\(s / 3600)h" }
    return "\(s / 86400)d"
}

struct PillButton: ButtonStyle {
    let tint: Color
    var filled = true
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .semibold))
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .foregroundStyle(filled ? Color.white : tint)
            .background(Capsule().fill(filled ? tint : tint.opacity(0.12)))
            .opacity(configuration.isPressed ? 0.75 : 1)
    }
}

struct IconButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(configuration.isPressed ? 0.12 : 0.05)))
    }
}

struct SectionHeader: View {
    let title: String
    var count: Int? = nil
    var body: some View {
        HStack(spacing: 6) {
            Text(title.uppercased()).font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
            if let count, count > 0 {
                Text("\(count)").font(.system(size: 10, weight: .bold)).foregroundStyle(.white)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Capsule().fill(Color.orange))
            }
            Spacer()
        }
    }
}

struct Placeholder: View {
    let text: String
    var body: some View {
        Text(text).font(.system(size: 12)).foregroundStyle(.tertiary).padding(.vertical, 2)
    }
}

struct Tag: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text).font(.system(size: 9, weight: .semibold)).foregroundStyle(color)
            .lineLimit(1).fixedSize() // never wrap: the name next to it truncates instead
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Capsule().fill(color.opacity(0.13)))
    }
}

/// One option in a row of choices: filled when it's the current one.
struct ChoiceButton: ButtonStyle {
    let tint: Color
    let selected: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 11, weight: .semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .foregroundStyle(selected ? Color.white : Color.primary.opacity(0.75))
            .background(Capsule().fill(selected ? tint : Color.primary.opacity(0.07)))
            .opacity(configuration.isPressed ? 0.75 : 1)
    }
}

// MARK: - Panel

enum PanelPage { case home, contacts }

struct PanelView: View {
    @EnvironmentObject var store: Store
    @State private var page: PanelPage = snapshotContacts ? .contacts : .home
    @State private var query = ""

    /// macOS doesn't keep a menu bar panel on screen: a long draft (opened with Show all), or many of
    /// them, pushed the buttons below the bottom of the screen. So the panel is at most as tall as
    /// the screen, and the middle (approvals, listening, recent) scrolls; header and footer stay put.
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 14) {
                header
                if let flash = store.flash {
                    Text(flash).font(.system(size: 11)).foregroundStyle(.secondary)
                        .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Color.accentColor.opacity(0.10)))
                }
            }
            .padding(14)
            middle
            VStack(alignment: .leading, spacing: 14) {
                Divider()
                footer
            }
            .padding([.horizontal, .bottom], 14)
        }
        .frame(width: 370)
        .frame(maxHeight: maxPanelHeight)
        // MenuBarExtra sizes its window to the content's minimum height, and a ScrollView's is 0;
        // pin it to the ideal height instead (the content's, capped by the frame above).
        .fixedSize(horizontal: false, vertical: true)
    }

    /// A ScrollView is as tall as its content until the panel's height cap squeezes it.
    @ViewBuilder private var middle: some View {
        if isSnapshot {
            // The offscreen snapshot renderer draws a ScrollView blank; this sizes the same, and clips.
            sections.fixedSize(horizontal: false, vertical: true)
                .frame(minHeight: 0, maxHeight: .infinity, alignment: .top).clipped()
        } else {
            ScrollView(.vertical) { sections }.scrollBounceBehavior(.basedOnSize)
        }
    }

    /// The screen the panel is on, below the menu bar and above the Dock, less a small gap.
    private var maxPanelHeight: CGFloat {
        let forced = ProcessInfo.processInfo.environment["SNAPSHOT_SCREEN_HEIGHT"].flatMap(Double.init) // for snapshots
        let visible = forced.map { CGFloat($0) } ?? (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame.height ?? 800
        return max(300, visible - 16)
    }

    private var sections: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let state = store.state, store.reachable {
                if let err = state.configError {
                    Label(err, systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 11)).foregroundStyle(.orange)
                }
                if page == .contacts {
                    ContactsList(contacts: state.contacts, query: query, defaultPolicy: state.defaultPolicy ?? "approve",
                                 waiting: state.approvals.count) { page = .home }
                } else {
                    approvals(state.approvals)
                    listening
                    recent
                }
            } else if let problem = store.problem {
                Text(problem).font(.system(size: 12)).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding([.horizontal, .bottom], 14)
    }

    @ViewBuilder private var header: some View {
        if page == .contacts { contactsHeader } else { homeHeader }
    }

    private var contactsHeader: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Button { page = .home } label: { Image(systemName: "chevron.left").font(.system(size: 12, weight: .semibold)) }
                    .buttonStyle(IconButton()).help("Back")
                VStack(alignment: .leading, spacing: 2) {
                    Text("Contacts").font(.system(size: 13, weight: .semibold))
                    let n = store.state?.contacts?.count ?? 0
                    Text("\(n) saved chat\(n == 1 ? "" : "s") · changes save to config.json at once")
                        .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
            }
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").font(.system(size: 11)).foregroundStyle(.secondary)
                // The offscreen snapshot renderer can't draw text fields; show the placeholder instead.
                if isSnapshot { Text("Search nickname, name, @username or id").foregroundStyle(.tertiary) }
                else { TextField("Search nickname, name, @username or id", text: $query).textFieldStyle(.plain) }
                Spacer(minLength: 0)
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.plain).foregroundStyle(.tertiary)
                }
            }
            .font(.system(size: 12))
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: 7).fill(Color.primary.opacity(0.06)))
        }
    }

    private var homeHeader: some View {
        let phase = store.reachable ? (store.state?.telegram.phase ?? "") : "unreachable"
        let (color, text): (Color, String) = {
            switch phase {
            case "connected":
                let me = store.state?.telegram.me
                return (.green, "Connected as \(me?.name ?? "?")\(me?.username.map { " (@\($0))" } ?? "")")
            case "connecting", "starting": return (.yellow, "Reconnecting… (it retries on its own)")
            case "logged_out": return (.red, "Logged out. Run tgmcp login")
            case "no_credentials": return (.red, "No API credentials. Run tgmcp login")
            default: return (.gray, "Daemon not reachable")
            }
        }()
        return HStack(spacing: 10) {
            Image(systemName: "paperplane.fill").font(.system(size: 16)).foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 2) {
                Text("Telegram MCP").font(.system(size: 13, weight: .semibold))
                HStack(spacing: 5) {
                    Circle().fill(color).frame(width: 7, height: 7)
                    Text(text).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer()
            Button { page = .contacts } label: { Label("Contacts", systemImage: "person.2") }
                .buttonStyle(IconButton())
                .help("Saved chats: nicknames, sending rules and auto-reply")
        }
    }

    private func approvals(_ items: [UiApproval]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "Waiting for approval", count: items.count)
            if items.isEmpty { Placeholder(text: "Nothing waiting") }
            ForEach(items) { ApprovalCard(item: $0) }
        }
    }

    private var listening: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "Listening")
            if store.listening.isEmpty { Placeholder(text: "No session is listening to a chat") }
            ForEach(store.listening) { SessionRow(session: $0) }
        }
    }

    private var recent: some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionHeader(title: "Recently sent")
            if store.recentChats.isEmpty { Placeholder(text: "Nothing sent yet") }
            ForEach(store.recentChats) { RecentChatRow(chat: $0) }
        }
    }

    private var footer: some View {
        HStack(spacing: 6) {
            Button { store.openFile("config.json") } label: { Label("Rules", systemImage: "list.bullet.rectangle") }
                .buttonStyle(IconButton())
            Button { store.openFile("daemon.log") } label: { Label("Log", systemImage: "doc.text") }
                .buttonStyle(IconButton())
            Button { store.restartDaemon() } label: { Label("Restart", systemImage: "arrow.clockwise") }
                .buttonStyle(IconButton())
            Spacer()
            Button { NSApp.terminate(nil) } label: { Label("Quit", systemImage: "power") }
                .buttonStyle(IconButton())
        }
    }
}

struct ApprovalCard: View {
    @EnvironmentObject var store: Store
    let item: UiApproval
    @State private var expanded = snapshotExpandApprovals
    @State private var nick: String

    init(item: UiApproval) {
        self.item = item
        _nick = State(initialValue: item.suggestedNickname)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.up.right.circle.fill").foregroundStyle(.orange)
                Text(item.to).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                Spacer()
                Text(ago(item.createdAt)).font(.system(size: 10)).foregroundStyle(.tertiary)
            }
            Text(item.text)
                .font(.system(size: 12))
                .lineLimit(expanded ? nil : 4)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 7).fill(Color.primary.opacity(0.05)))
                .contentShape(Rectangle())
                .onTapGesture { toggle() }
            if long {
                HStack {
                    Spacer()
                    Button(expanded ? "Show less" : "Show all", action: toggle)
                        .buttonStyle(.plain)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Color.accentColor)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(item.detail).lineLimit(1)
                Text("\(item.reason) · \(item.sessionLabel)").lineLimit(2)
            }
            .font(.system(size: 10)).foregroundStyle(.secondary)
            if item.firstTime { firstTimeRow }
            HStack(spacing: 8) {
                Spacer()
                let busy = store.busy.contains(item.id)
                Button("Deny") { Task { await store.decide(item.id, approve: false) } }
                    .buttonStyle(PillButton(tint: .red, filled: false)).disabled(busy)
                if item.firstTime {
                    Button("Ask every time") {
                        Task { await store.decide(item.id, approve: true, remember: "requireApproval", nickname: nick) }
                    }
                    .buttonStyle(PillButton(tint: .green, filled: false)).disabled(busy)
                    .help("Send now; future messages to this chat need approval too")
                    Button(busy ? "Sending…" : "Always allow") {
                        Task { await store.decide(item.id, approve: true, remember: "autoSend", nickname: nick) }
                    }
                    .buttonStyle(PillButton(tint: .green)).disabled(busy)
                    .help("Send now and whitelist this chat: future messages send without asking")
                } else {
                    Button(busy ? "Sending…" : "Approve") { Task { await store.decide(item.id, approve: true) } }
                        .buttonStyle(PillButton(tint: .green)).disabled(busy)
                }
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.orange.opacity(0.07)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.orange.opacity(0.25)))
    }

    private var long: Bool { isLongDraft(item.text) }

    /// A click on a long draft (or on Show all) opens it; another closes it.
    private func toggle() {
        guard long else { return }
        withAnimation(.easeOut(duration: 0.12)) { expanded.toggle() }
    }

    /// First message to this chat: it gets saved, and the buttons decide what happens next time.
    private var firstTimeRow: some View {
        HStack(spacing: 6) {
            Image(systemName: "person.crop.circle.badge.plus").font(.system(size: 11)).foregroundStyle(.blue)
            Text("New chat, save as").font(.system(size: 11)).foregroundStyle(.secondary)
            if let existing = item.nickname {
                Text(existing).font(.system(size: 11, weight: .semibold))
            } else {
                // The offscreen snapshot renderer can't draw text fields; show the value instead.
                Group {
                    if isSnapshot { Text(nick).frame(maxWidth: .infinity, alignment: .leading) }
                    else { TextField("nickname", text: $nick).textFieldStyle(.plain) }
                }
                    .font(.system(size: 11, weight: .semibold))
                    .padding(.horizontal, 6).padding(.vertical, 3)
                    .background(RoundedRectangle(cornerRadius: 5).fill(Color.primary.opacity(0.07)))
                    .frame(maxWidth: 150)
            }
            Spacer()
        }
    }
}

struct SessionRow: View {
    let session: UiSession

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Image(systemName: "terminal").font(.system(size: 11)).foregroundStyle(.secondary)
                Text(session.label).font(.system(size: 12, weight: .medium)).lineLimit(1)
                Spacer()
                badge
            }
            ForEach(session.watches) { w in
                HStack(spacing: 6) {
                    Image(systemName: "ear").font(.system(size: 10)).foregroundStyle(.blue)
                    Text(w.chatLabel).font(.system(size: 11)).lineLimit(1)
                    if let from = w.fromLabel { Text("from \(from)").font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1) }
                    if let topic = w.topicId { Text("topic \(topic)").font(.system(size: 10)).foregroundStyle(.secondary) }
                    Spacer()
                }
                .padding(.leading, 17)
                .help(w.note ?? w.chatLabel)
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.04)))
    }

    @ViewBuilder private var badge: some View {
        if !session.connected {
            tag("session gone", .gray)
        } else if session.channel {
            tag("push", .green)
        } else if session.monitors > 0 {
            tag("Monitor on", .green)
        } else {
            tag(session.pending > 0 ? "Monitor off · \(session.pending) queued" : "Monitor off", .orange)
        }
    }

    private func tag(_ text: String, _ color: Color) -> some View { Tag(text: text, color: color) }
}

// MARK: - Contacts page

/// Every saved chat (`chats` in config.json). Click one to change its nickname, which list decides
/// sending there, and whether sessions may listen and auto-reply. Each click saves at once.
struct ContactsList: View {
    @EnvironmentObject var store: Store
    let contacts: [UiContact]?
    let query: String
    let defaultPolicy: String
    let waiting: Int
    let showApprovals: () -> Void
    @State private var open: String? = snapshotOpenContact

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if waiting > 0 {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.up.right.circle.fill").foregroundStyle(.orange)
                    Text("\(waiting) waiting for approval").font(.system(size: 11, weight: .medium))
                    Spacer()
                    Button("Show", action: showApprovals).buttonStyle(PillButton(tint: .orange, filled: false))
                }
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.orange.opacity(0.08)))
            }
            if let contacts {
                let shown = filtered(contacts)
                if contacts.isEmpty {
                    Placeholder(text: "No saved chats yet. Approving the first message to a chat saves it.")
                } else if shown.isEmpty {
                    Placeholder(text: "No saved chat matches \u{201C}\(query)\u{201D}")
                }
                ForEach(shown) { ContactRow(contact: $0, defaultPolicy: defaultPolicy, open: $open) }
            } else {
                Placeholder(text: "The daemon is older than this app. Restart it (below) to edit contacts.")
            }
        }
    }

    private func filtered(_ list: [UiContact]) -> [UiContact] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return list }
        return list.filter { c in
            ([c.nickname, c.name ?? "", c.username.map { "@\($0)" } ?? "", String(c.chatId)] + c.aliases)
                .contains { $0.lowercased().contains(q) }
        }
    }
}

struct ContactRow: View {
    @EnvironmentObject var store: Store
    let contact: UiContact
    let defaultPolicy: String
    @Binding var open: String?
    @State private var nick: String
    @State private var reason = ""

    init(contact: UiContact, defaultPolicy: String, open: Binding<String?>) {
        self.contact = contact
        self.defaultPolicy = defaultPolicy
        _open = open
        _nick = State(initialValue: contact.nickname)
    }

    private var isOpen: Bool { open == contact.nickname }
    private var busy: Bool { store.busy.contains("contact:\(contact.nickname)") }
    private var paging: Bool { store.busy.contains("page:\(contact.nickname)") }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(.easeOut(duration: 0.12)) { open = isOpen ? nil : contact.nickname }
            } label: { summary }
                .buttonStyle(.plain)
            if isOpen { editor.transition(.opacity) }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(isOpen ? 0.06 : 0.035)))
    }

    private var summary: some View {
        HStack(spacing: 7) {
            Image(systemName: typeIcon).font(.system(size: 11)).foregroundStyle(.secondary).frame(width: 15)
            VStack(alignment: .leading, spacing: 1) {
                Text(contact.nickname).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                if !subtitle.isEmpty {
                    Text(subtitle).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            if contact.pagesMe { Tag(text: "can page me", color: .pink) }
            if contact.autoReply { Tag(text: "auto-reply", color: .blue) }
            Tag(text: modeTag.text, color: modeTag.color)
            Image(systemName: "chevron.down")
                .font(.system(size: 9, weight: .semibold)).foregroundStyle(.tertiary)
                .rotationEffect(.degrees(isOpen ? 180 : 0))
        }
        .contentShape(Rectangle())
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 10) {
            field("Nickname") {
                HStack(spacing: 6) {
                    Group {
                        if isSnapshot { Text(nick).frame(maxWidth: .infinity, alignment: .leading) }
                        else { TextField("nickname", text: $nick).textFieldStyle(.plain).onSubmit(rename) }
                    }
                    .font(.system(size: 12, weight: .medium))
                    .padding(.horizontal, 7).padding(.vertical, 4)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.07)))
                    Button("Rename", action: rename)
                        .buttonStyle(ChoiceButton(tint: .accentColor, selected: renamed))
                        .disabled(!renamed || busy)
                }
            }
            field("When Claude sends a message here") {
                HStack(spacing: 6) {
                    choice("Always allow", mode: "autoSend", tint: .green, help: "Send without asking (autoSend)")
                    choice("Ask every time", mode: "requireApproval", tint: .orange, help: "Every message waits for your approval (requireApproval)")
                    choice("Blocked", mode: "blocked", tint: .red, help: "Never send here (blocked)")
                }
            }
            field("Auto-reply") {
                HStack(spacing: 6) {
                    Button("On") { save(["autoReply": true], unless: contact.autoReply) }
                        .buttonStyle(ChoiceButton(tint: .blue, selected: contact.autoReply))
                        .help("Sessions may listen to this chat and reply without asking while they do (autoReply)")
                    Button("Off") { save(["autoReply": false], unless: !contact.autoReply) }
                        .buttonStyle(ChoiceButton(tint: .gray, selected: !contact.autoReply))
                        .help("Sessions can't listen to this chat")
                }
            }
            if contact.canPage {
                field("Can page me") {
                    HStack(spacing: 6) {
                        Button("On") { save(["pageFrom": true], unless: contact.pagesMe) }
                            .buttonStyle(ChoiceButton(tint: .pink, selected: contact.pagesMe))
                            .help("Their \u{201C}/page <reason>\u{201D} rings your desktop until you ack it (paging.pageFrom)")
                        Button("Off") { save(["pageFrom": false], unless: !contact.pagesMe) }
                            .buttonStyle(ChoiceButton(tint: .gray, selected: !contact.pagesMe))
                            .help("Their /page is ignored")
                    }
                }
                field("Page \(contact.nickname)") {
                    HStack(spacing: 6) {
                        Group {
                            if isSnapshot { Text(reason.isEmpty ? "Reason (optional)" : reason).foregroundStyle(.tertiary).frame(maxWidth: .infinity, alignment: .leading) }
                            else { TextField("Reason (optional)", text: $reason).textFieldStyle(.plain).onSubmit(page) }
                        }
                        .font(.system(size: 12))
                        .padding(.horizontal, 7).padding(.vertical, 4)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.07)))
                        Button(action: page) {
                            Label(paging ? "Paging…" : "Page", systemImage: "bell.and.waves.left.and.right.fill")
                        }
                        .buttonStyle(PillButton(tint: .red, filled: true))
                        .disabled(paging || blocked)
                        .help("Sends \u{201C}/page <reason>\u{201D} to \(contact.nickname) from your account. It rings them if you\u{2019}re on their pageFrom.")
                    }
                }
            }
            Text(explanation)
                .font(.system(size: 10)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(details)
                .font(.system(size: 9)).foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .padding(.leading, 22)
        .disabled(busy)
    }

    private func field<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
            content()
        }
    }

    private func choice(_ title: String, mode: String, tint: Color, help: String) -> some View {
        Button(title) { save(["sendMode": mode], unless: contact.sendMode == mode) }
            .buttonStyle(ChoiceButton(tint: tint, selected: contact.sendMode == mode))
            .help(help)
    }

    private func save(_ change: [String: Any], unless current: Bool) {
        guard !current, !busy else { return }
        Task { await store.editContact(contact.nickname, change) }
    }

    /// Blocked by its own rule, or on no list while the default blocks: the daemon refuses a page.
    private var blocked: Bool {
        contact.sendMode == "blocked" || (contact.sendMode == "none" && defaultPolicy == "block")
    }

    private func page() {
        guard !paging, !blocked else { return }
        let why = reason
        Task { if await store.pageContact(contact.nickname, reason: why) { reason = "" } }
    }

    private var renamed: Bool {
        let t = nick.trimmingCharacters(in: .whitespacesAndNewlines)
        return !t.isEmpty && t != contact.nickname
    }

    private func rename() {
        guard renamed, !busy else { return }
        let wanted = nick
        Task {
            // The row is keyed by nickname, so keep the renamed one open.
            if let now = await store.editContact(contact.nickname, ["rename": wanted]) { open = now }
        }
    }

    private var typeIcon: String {
        switch contact.type {
        case "user": return "person.fill"
        case "bot": return "cpu"
        case "group": return "person.3.fill"
        case "channel": return "megaphone.fill"
        default: return "bubble.left.fill"
        }
    }

    private var subtitle: String {
        [contact.name, contact.username.map { "@\($0)" }].compactMap { $0 }.joined(separator: " · ")
    }

    private var modeTag: (text: String, color: Color) {
        switch contact.sendMode {
        case "autoSend": return ("always allow", .green)
        case "requireApproval": return ("ask every time", .orange)
        case "blocked": return ("blocked", .red)
        default: return defaultPolicy == "block" ? ("blocked by default", .red) : ("not set", .gray)
        }
    }

    private var explanation: String {
        let send: String
        switch contact.sendMode {
        case "autoSend": send = "Messages go out without asking."
        case "requireApproval": send = "Every message waits for your approval."
        case "blocked": send = "Nothing is ever sent here."
        default:
            send = defaultPolicy == "block"
                ? "On no list, so the default rule blocks it."
                : "On no list yet: the next message asks you, and you pick what happens after."
        }
        let reply: String
        if !contact.autoReply { reply = "Sessions can't listen to this chat." }
        else if contact.sendMode == "requireApproval" { reply = "Sessions may listen here, but their replies still ask first." }
        else if contact.sendMode == "blocked" { reply = "Sessions may listen here, but can't reply." }
        else { reply = "Sessions may listen here and reply without asking while they do." }
        guard contact.canPage else { return "\(send) \(reply)" }
        let page = contact.pagesMe ? "Their /page rings you." : "Their /page is ignored."
        return "\(send) \(reply) \(page)"
    }

    private var details: String {
        var bits = ["id \(contact.chatId)"]
        if let t = contact.topicId { bits.append("topic \(t)") }
        if !contact.aliases.isEmpty { bits.append("aliases: \(contact.aliases.joined(separator: ", "))") }
        if !contact.sameChat.isEmpty {
            bits.append("same chat as \(contact.sameChat.joined(separator: ", ")), so these rules apply to it too")
        }
        if let n = contact.notes, !n.isEmpty { bits.append(n) }
        return bits.joined(separator: " · ")
    }
}

struct RecentChatRow: View {
    @EnvironmentObject var store: Store
    let chat: RecentChat
    @State private var open = snapshotExpandRecent

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Button {
                withAnimation(.easeOut(duration: 0.12)) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "bubble.left.fill").font(.system(size: 10)).foregroundStyle(Color.accentColor.opacity(0.8))
                    Text(chat.label).font(.system(size: 12)).lineLimit(1)
                    if chat.messages.count > 1 {
                        Text("\(chat.messages.count)").font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(ago(chat.messages[0].at)).font(.system(size: 10)).foregroundStyle(.tertiary)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 8, weight: .semibold)).foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(open ? 180 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(open ? "Hide what was sent" : "Show what was sent")
            if open {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(chat.messages.prefix(3)) { m in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(store.body(m.text)).font(.system(size: 11)).fixedSize(horizontal: false, vertical: true)
                            Text("\(ago(m.at)) · \(viaLabel(m.via))\(m.sessionLabel.map { " · \($0)" } ?? "")")
                                .font(.system(size: 9)).foregroundStyle(.tertiary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(7)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Color.accentColor.opacity(0.07)))
                    }
                }
                .padding(.leading, 16)
                .transition(.opacity)
            }
        }
        .padding(.vertical, 5)
        .padding(.horizontal, 7)
        .background(RoundedRectangle(cornerRadius: 7).fill(open ? Color.primary.opacity(0.05) : .clear))
    }

    private func viaLabel(_ via: String) -> String {
        switch via {
        case "auto": return "auto-sent"
        case "menubar": return "approved in menu bar"
        case "dialog": return "approved in dialog"
        default: return "approved in chat"
        }
    }
}

// MARK: - Menu bar icon

/// The menu bar icon, drawn like Telegram's: a glyph with a small badge on its lower-right corner.
/// It's a template image, so macOS tints it for light, dark and coloured menu bars. The badge text
/// is knocked out of the badge (the bar shows through), with a clear ring separating it from the glyph.
enum MenuBarIcon {
    static func image(symbol: String, badge: String?) -> NSImage {
        let size = NSSize(width: badge == nil ? 18 : 22, height: 18)
        let image = NSImage(size: size, flipped: false) { rect in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            let config = NSImage.SymbolConfiguration(pointSize: 14, weight: .medium)
            if let glyph = NSImage(systemSymbolName: symbol, accessibilityDescription: "Telegram MCP")?
                .withSymbolConfiguration(config) {
                let g = glyph.size
                let x = badge == nil ? (rect.width - g.width) / 2 : 1
                glyph.draw(in: NSRect(x: x, y: (rect.height - g.height) / 2 + 1, width: g.width, height: g.height))
            }
            guard let badge else { return true }

            let font = NSFont.systemFont(ofSize: 8.5, weight: .heavy)
            let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.black]
            let textSize = (badge as NSString).size(withAttributes: attrs)
            let height: CGFloat = 10.5
            let width = max(height, textSize.width + 4.5)
            let pill = NSRect(x: rect.width - width, y: 0, width: width, height: height)

            ctx.setBlendMode(.clear) // gap between badge and glyph
            NSBezierPath(roundedRect: pill.insetBy(dx: -1.4, dy: -1.4), xRadius: height / 2 + 1.4, yRadius: height / 2 + 1.4).fill()
            ctx.setBlendMode(.normal)
            NSColor.black.setFill()
            NSBezierPath(roundedRect: pill, xRadius: height / 2, yRadius: height / 2).fill()
            ctx.setBlendMode(.destinationOut) // number shows the bar through the badge
            (badge as NSString).draw(
                at: NSPoint(x: pill.midX - textSize.width / 2, y: pill.midY - textSize.height / 2 + 0.3),
                withAttributes: attrs)
            ctx.setBlendMode(.normal)
            return true
        }
        image.isTemplate = true
        return image
    }

    static func badgeText(_ n: Int) -> String { n > 99 ? "99+" : "\(n)" }
}

struct MenuIcon: View {
    @ObservedObject var store: Store

    var body: some View {
        let waiting = store.state?.approvals.count ?? 0
        let healthy = store.reachable && store.state?.telegram.phase == "connected"
        let symbol = store.listening.isEmpty ? "paperplane" : "paperplane.fill"
        if waiting > 0 {
            Image(nsImage: MenuBarIcon.image(symbol: symbol, badge: MenuBarIcon.badgeText(waiting)))
        } else if !healthy {
            Image(nsImage: MenuBarIcon.image(symbol: symbol, badge: "!"))
        } else {
            Image(nsImage: MenuBarIcon.image(symbol: symbol, badge: nil))
        }
    }
}

/// `--icons out.png`: every icon state, tinted the way macOS tints template images, on dark and light bars.
@MainActor
enum IconPreview {
    static func run(to path: String) {
        _ = NSApplication.shared
        let states: [(String, String?)] = [
            ("paperplane", nil), ("paperplane.fill", nil), ("paperplane", "1"),
            ("paperplane", "2"), ("paperplane.fill", "12"), ("paperplane", "!"),
        ]
        let scale: CGFloat = 6
        let cell = NSSize(width: 34, height: 24)
        let bars: [(NSColor, NSColor)] = [
            (NSColor(srgbRed: 0.27, green: 0.20, blue: 0.62, alpha: 1), .white), // tinted (like the screenshot)
            (NSColor(white: 0.12, alpha: 1), .white),
            (NSColor(white: 0.93, alpha: 1), .black),
        ]
        let size = NSSize(width: cell.width * CGFloat(states.count) * scale, height: cell.height * CGFloat(bars.count) * scale)
        let out = NSImage(size: size, flipped: false) { _ in
            for (row, bar) in bars.enumerated() {
                let y = CGFloat(bars.count - 1 - row) * cell.height * scale
                bar.0.setFill()
                NSRect(x: 0, y: y, width: size.width, height: cell.height * scale).fill()
                for (col, state) in states.enumerated() {
                    let icon = MenuBarIcon.image(symbol: state.0, badge: state.1)
                    let tinted = NSImage(size: icon.size, flipped: false) { r in
                        icon.draw(in: r)
                        bar.1.setFill()
                        r.fill(using: .sourceAtop)
                        return true
                    }
                    let w = icon.size.width * scale, h = icon.size.height * scale
                    let x = CGFloat(col) * cell.width * scale + (cell.width * scale - w) / 2
                    tinted.draw(in: NSRect(x: x, y: y + (cell.height * scale - h) / 2, width: w, height: h))
                }
            }
            return true
        }
        if let tiff = out.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
           let png = rep.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: path))
            print("wrote \(path)")
        }
    }
}

// MARK: - Pages

/// The on-call alarm: a looping tone and a window above everything, on every Space, until you
/// ack or snooze. It plays the sound itself, since a notification sound plays once and Focus can
/// silence it.
@MainActor
final class PageAlarm {
    private var player: AVAudioPlayer?
    private var panel: NSPanel?

    func update(ringing: [UiPage], store: Store) {
        guard !ringing.isEmpty else {
            player?.stop()
            player = nil
            panel?.orderOut(nil)
            return
        }
        if player == nil, let p = Self.player(home: store.home) {
            p.numberOfLoops = -1
            p.volume = 1
            p.play()
            player = p
        }
        let panel = self.panel ?? makePanel(store: store)
        self.panel = panel
        let showing = panel.isVisible
        // SwiftUI lays the new pages out on the next pass; size the panel to them after that.
        DispatchQueue.main.async {
            Self.fit(panel)
            if !showing {
                panel.center()
                panel.orderFrontRegardless()
            }
        }
    }

    /// The panel follows its content: taller for another page, shorter when one is acked, and
    /// never taller than the screen. The top edge stays put, so the buttons don't jump.
    static func fit(_ panel: NSPanel) {
        guard let content = panel.contentView else { return }
        let screen = (panel.screen ?? NSScreen.main)?.visibleFrame.height ?? 800
        let size = NSSize(width: PageAlarmView.width, height: min(content.fittingSize.height, screen - 40))
        let current = panel.contentRect(forFrameRect: panel.frame).size
        guard abs(current.height - size.height) > 0.5 || abs(current.width - size.width) > 0.5 else { return }
        var frame = panel.frameRect(forContentRect: NSRect(origin: .zero, size: size))
        frame.origin = NSPoint(x: panel.frame.minX, y: panel.frame.maxY - frame.height)
        panel.setFrame(frame, display: true)
    }

    /// Your own sound if there is one (alarm.mp3, .m4a, .wav, .aiff or .caf in the home folder),
    /// else the built-in beep. Read on each new page, so a new file needs no restart.
    static func player(home: URL) -> AVAudioPlayer? {
        for ext in ["mp3", "m4a", "wav", "aiff", "caf"] {
            let url = home.appendingPathComponent("alarm.\(ext)")
            if FileManager.default.isReadableFile(atPath: url.path), let p = try? AVAudioPlayer(contentsOf: url) { return p }
        }
        return try? AVAudioPlayer(data: AlarmTone.wav, fileTypeHint: AVFileType.wav.rawValue)
    }

    private func makePanel(store: Store) -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: PageAlarmView.width, height: 220),
            styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isFloatingPanel = true
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        // The panel is sized by fit(), not by the hosting view, which would only ever grow it.
        let host = NSHostingView(rootView: PageAlarmView().environmentObject(store))
        host.sizingOptions = []
        panel.contentView = host
        return panel
    }
}

/// A two-tone pager beep, made here so the app needs no sound file.
enum AlarmTone {
    static let wav: Data = {
        let rate = 44_100
        var samples: [Int16] = []
        func tone(_ hz: Double, _ seconds: Double) {
            let n = Int(Double(rate) * seconds)
            for i in 0..<n {
                let fade = min(1, Double(i) / 300, Double(n - i) / 300)
                samples.append(Int16(sin(2 * .pi * hz * Double(i) / Double(rate)) * fade * 0.85 * 32_767))
            }
        }
        func silence(_ seconds: Double) { samples += Array(repeating: 0, count: Int(Double(rate) * seconds)) }
        for _ in 0..<3 { tone(988, 0.12); silence(0.05) }
        tone(740, 0.3)
        silence(0.5)
        var data = Data()
        func put<T: FixedWidthInteger>(_ v: T) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        let bytes = samples.count * 2
        data.append(contentsOf: Array("RIFF".utf8)); put(UInt32(36 + bytes))
        data.append(contentsOf: Array("WAVEfmt ".utf8)); put(UInt32(16)); put(UInt16(1)); put(UInt16(1))
        put(UInt32(rate)); put(UInt32(rate * 2)); put(UInt16(2)); put(UInt16(16))
        data.append(contentsOf: Array("data".utf8)); put(UInt32(bytes))
        for s in samples { put(s) }
        return data
    }()
}

struct PageAlarmView: View {
    static let width: CGFloat = 420
    /// More than this and the rest wait behind "+N more": the panel has to fit a laptop screen.
    static let maxCards = 3

    @EnvironmentObject var store: Store

    var body: some View {
        let ringing = store.pages.filter(\.ringing)
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "bell.and.waves.left.and.right.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.red)
                Text(ringing.count > 1 ? "\(ringing.count) pages" : "Page")
                    .font(.system(size: 17, weight: .bold))
                Spacer()
            }
            ForEach(ringing.prefix(Self.maxCards)) { page in
                PageCard(page: page)
            }
            if ringing.count > Self.maxCards {
                Text("+\(ringing.count - Self.maxCards) more: ack these to see them")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
        }
        .padding(18)
        .frame(width: Self.width)
        .fixedSize(horizontal: false, vertical: true)
    }
}

struct PageCard: View {
    @EnvironmentObject var store: Store
    let page: UiPage

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(page.from).font(.system(size: 13, weight: .semibold))
            if let chat = page.chat {
                Text(chat).font(.system(size: 11)).foregroundStyle(.secondary)
            }
            Text(page.reason.isEmpty ? "No reason given" : page.reason)
                .font(.system(size: 13))
                .fixedSize(horizontal: false, vertical: true)
            if page.state == "unanswered" {
                Text("Not acked on the phone either; the sender was told to call.")
                    .font(.system(size: 11)).foregroundStyle(.orange)
            }
            HStack(spacing: 8) {
                Button("Ack") { Task { await store.page(page.id, ack: true) } }
                    .buttonStyle(PillButton(tint: .red))
                    .keyboardShortcut(.defaultAction)
                Button("Snooze 15m") { Task { await store.page(page.id, ack: false, minutes: 15) } }
                    .buttonStyle(PillButton(tint: .secondary, filled: false))
                Button("1h") { Task { await store.page(page.id, ack: false, minutes: 60) } }
                    .buttonStyle(PillButton(tint: .secondary, filled: false))
                Spacer()
                if let url = page.messageURL {
                    Button("Open message") { NSWorkspace.shared.open(url) }
                        .buttonStyle(IconButton())
                }
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.red.opacity(0.08)))
    }
}

// MARK: - App

struct TelegramMCPBarApp: App {
    @StateObject private var store = Store()
    private let notifications = NotificationHandler()

    var body: some Scene {
        MenuBarExtra {
            PanelView().environmentObject(store).onAppear { notifications.setUp(store: store) }
        } label: {
            MenuIcon(store: store).task { notifications.setUp(store: store) }
        }
        .menuBarExtraStyle(.window)
    }
}

/// `--snapshot out.png` renders the panel with live data to an image and exits (for checking the layout).
@MainActor
enum Snapshot {
    static func run(to path: String) {
        _ = NSApplication.shared
        let store = Store(polling: false)
        Task { @MainActor in
            await store.poll()
            let view = PanelView().environmentObject(store)
                .background(Color(nsColor: .windowBackgroundColor))
                .environment(\.colorScheme, ProcessInfo.processInfo.environment["SNAPSHOT_DARK"] == "1" ? .dark : .light)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            if let image = renderer.nsImage, let tiff = image.tiffRepresentation,
               let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: path))
                print("wrote \(path)")
            } else {
                print("render failed")
            }
            exit(0)
        }
        RunLoop.main.run()
    }
}

@main
enum Main {
    static func main() {
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--icons"), i + 1 < args.count {
            MainActor.assumeIsolated { IconPreview.run(to: args[i + 1]) }
            return
        }
        if let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count {
            MainActor.assumeIsolated { Snapshot.run(to: args[i + 1]) }
            return
        }
        TelegramMCPBarApp.main()
    }
}
