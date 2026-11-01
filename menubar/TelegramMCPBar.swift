// Menu bar companion for the telegram-mcp daemon.
// Shows approvals (approve / deny), which Claude sessions are listening to which chats,
// and the chats you last sent to (hover a chat to see what was sent).
// Talks only to the local daemon on 127.0.0.1, authenticated with ~/.config/telegram-mcp/token.

import AppKit
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

struct UiState: Decodable {
    let telegram: TelegramState
    let configError: String?
    let footer: String
    let approvals: [UiApproval]
    let sessions: [UiSession]
    let recent: [SentRecord]
}

/// The chats you last sent to, newest first, each with the messages sent there.
struct RecentChat: Identifiable {
    let id: Int
    let label: String
    let messages: [SentRecord]
}

// MARK: - Talking to the daemon

@MainActor
final class Store: ObservableObject {
    @Published var state: UiState?
    @Published var reachable = false
    @Published var problem: String?
    @Published var busy: Set<String> = []
    @Published var flash: String?

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

    private var token: String? {
        (try? String(contentsOf: home.appendingPathComponent("token"), encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func request(_ path: String, method: String = "GET", body: [String: String]? = nil) -> URLRequest? {
        guard let token, let url = URL(string: "http://127.0.0.1:\(port)\(path)") else { return nil }
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
        guard let req = request("/ui/state") else {
            reachable = false
            problem = "No token yet. Is the daemon installed? (tgmcp install)"
            return
        }
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
                reachable = false
                problem = "The daemon refused the request (token mismatch?)."
                return
            }
            let next = try JSONDecoder().decode(UiState.self, from: data)
            state = next
            reachable = true
            problem = nil
            notifyNewApprovals(next.approvals)
        } catch {
            reachable = false
            problem = "The daemon is not running. It restarts by itself; or run tgmcp install."
        }
    }

    /// `remember` (first message to a chat): "autoSend" = always allow, "requireApproval" = ask every time.
    func decide(_ id: String, approve: Bool, remember: String? = nil, nickname: String? = nil) async {
        var body = ["decision": approve ? "approve" : "deny"]
        if let remember { body["remember"] = remember }
        if let nickname, !nickname.trimmingCharacters(in: .whitespaces).isEmpty { body["nickname"] = nickname }
        guard let req = request("/ui/approvals/\(id)", method: "POST", body: body) else { return }
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

// MARK: - Panel

struct PanelView: View {
    @EnvironmentObject var store: Store

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            if let flash = store.flash {
                Text(flash).font(.system(size: 11)).foregroundStyle(.secondary)
                    .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.accentColor.opacity(0.10)))
            }
            if let state = store.state, store.reachable {
                if let err = state.configError {
                    Label(err, systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 11)).foregroundStyle(.orange)
                }
                approvals(state.approvals)
                listening
                recent
            } else if let problem = store.problem {
                Text(problem).font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Divider()
            footer
        }
        .padding(14)
        .frame(width: 370)
    }

    private var header: some View {
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
    @State private var hover = false
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
                .lineLimit(hover ? nil : 4)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 7).fill(Color.primary.opacity(0.05)))
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
        .onHover { h in withAnimation(.easeOut(duration: 0.12)) { hover = h } }
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

    private func tag(_ text: String, _ color: Color) -> some View {
        Text(text).font(.system(size: 9, weight: .semibold)).foregroundStyle(color)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Capsule().fill(color.opacity(0.13)))
    }
}

struct RecentChatRow: View {
    @EnvironmentObject var store: Store
    let chat: RecentChat
    @State private var hover = ProcessInfo.processInfo.environment["SNAPSHOT_HOVER"] == "1"

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Image(systemName: "bubble.left.fill").font(.system(size: 10)).foregroundStyle(Color.accentColor.opacity(0.8))
                Text(chat.label).font(.system(size: 12)).lineLimit(1)
                if chat.messages.count > 1 {
                    Text("\(chat.messages.count)").font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
                }
                Spacer()
                Text(ago(chat.messages[0].at)).font(.system(size: 10)).foregroundStyle(.tertiary)
            }
            if hover {
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
        .background(RoundedRectangle(cornerRadius: 7).fill(hover ? Color.primary.opacity(0.05) : .clear))
        .contentShape(Rectangle())
        .onHover { h in withAnimation(.easeOut(duration: 0.12)) { hover = h } }
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
