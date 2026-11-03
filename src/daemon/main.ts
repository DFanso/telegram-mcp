import { join } from 'node:path'
import { firstName } from '../shared/away'
import { ConfigStore, isListed } from '../shared/config'
import { ensureHome, makeLogger } from '../shared/files'
import { getPaths, getPort, type Paths } from '../shared/paths'
import { ensureToken, loadCredentials, openSecretStore, type SecretStore } from '../shared/secrets'
import { Approvals } from './approvals'
import { AvatarCache } from './avatars'
import { AwayResponder } from './away'
import { PageBot } from './page-bot'
import { Pager, pageTrigger } from './pager'
import { eventsKey, startServer } from './server'
import { openSessionStorage } from './session-store'
import { Service, describeMessage } from './service'
import { SessionHub, type HubOptions } from './sessions'
import { MtcuteTelegram, type TelegramPort } from './telegram'

/** How old an incoming /page or keyword can be and still page. */
export const PAGE_MAX_AGE_MS = 2 * 60_000

export interface DaemonOptions {
  paths: Paths
  port: number
  /** Inject a fake in tests; defaults to the real mtcute client. */
  telegram?: TelegramPort
  hub?: HubOptions
  log?: (msg: string) => void
  /** Defaults to the OS keystore (or files with TELEGRAM_MCP_SECRET_STORE=file). */
  secrets?: SecretStore
  /** Tests: a pager bot token (null for none) instead of the keystore's, and a fake Bot API. */
  pageBotToken?: string | null
  pageBotFetch?: (url: string, init?: RequestInit) => Promise<Response>
  pageTickMs?: number
}

export async function createDaemon(o: DaemonOptions) {
  const log = o.log ?? makeLogger(o.paths)
  const startedAt = Date.now()
  ensureHome(o.paths)
  const secrets = o.secrets ?? openSecretStore(o.paths)
  const token = await ensureToken(secrets)
  const store = new ConfigStore(o.paths.config, log)
  const tg =
    o.telegram ??
    new MtcuteTelegram({
      openStorage: () => openSessionStorage(o.paths.session, secrets, { log }),
      loadCredentials: () => loadCredentials(secrets),
      log,
    })
  const hub = new SessionHub({ log, ...o.hub })
  const approvals = new Approvals()

  // Pages ring the menu bar / tray (they read them from /ui/state) and, with a pager bot, the phone.
  const ownerId = () => tg.state().me?.id ?? null
  const pager: Pager = new Pager({
    paging: () => store.get().paging,
    ownerName: () => firstName(tg.state().me) ?? 'They',
    channel: () => bot,
    // The fixed replies go out from your account, through the same rules as any send.
    tellSender: (chatId, text, replyTo) => service.tellPageSender(chatId, text, replyTo),
    auditPath: o.paths.pages,
    log,
  })
  const botToken = o.pageBotToken !== undefined ? o.pageBotToken : await secrets.get('page-bot')
  const bot = botToken
    ? new PageBot({
        token: botToken,
        ownerId,
        onAction: (id, action) => void pager.act(id, action, 'phone'),
        log,
        fetch: o.pageBotFetch,
      })
    : null

  const away = new AwayResponder({
    config: () => store.get(),
    tg,
    hub,
    pages: () => pager.active(),
    record: r => service.recordSent(r),
    statePath: join(o.paths.home, 'away.json'),
    log,
  })

  let port = o.port
  const service = new Service({
    store,
    tg,
    hub,
    approvals,
    // A key that opens this one session's stream and nothing else: the URL ends up in Claude transcripts.
    eventsUrl: sid => `ws://127.0.0.1:${port}/events?session=${sid}&key=${eventsKey(token, sid)}`,
    recentPath: join(o.paths.home, 'recent.json'),
    downloadsDir: o.paths.downloads,
    mcpHome: o.paths.home,
    pager,
    away,
    log,
  })

  // Bind first: if another daemon already owns the port, fail before touching the Telegram session.
  const server = startServer({
    port: o.port,
    token,
    secrets: { kind: secrets.kind, where: secrets.where },
    service,
    hub,
    tg,
    store,
    avatars: new AvatarCache({ dir: o.paths.avatars, fetch: chatId => tg.profilePhoto(chatId), log }),
    log,
    startedAt,
  })
  port = server.port ?? o.port
  store.watch()

  tg.onMessage(msg => {
    if (msg.outgoing) {
      // The message's own time: a catch-up after sleep replays old sends, which mustn't count as just now.
      const sentAt = Date.parse(msg.date)
      away.noteOutgoing(msg.chatId, Number.isNaN(sentAt) ? Date.now() : sentAt)
      service
        .handleOwnMessage(msg)
        .then(cmd => cmd && log(`/reply in ${msg.chatId}: ${hub.takeoverOf(msg.chatId) ?? 'no session took it (or it ended)'}`))
        .catch(e => log(`/reply in ${msg.chatId} failed: ${e instanceof Error ? e.message : String(e)}`))
      return
    }
    const trigger = pageTrigger(store.get(), msg)
    // Messages that arrive late (the catch-up after a restart or a long disconnect) never page:
    // whatever it was is old news, and the sender would hear "Paging Leo now" an hour on.
    const age = Date.now() - Date.parse(msg.date)
    if (trigger && age > PAGE_MAX_AGE_MS) {
      log(`page from ${msg.from!.id} in ${msg.chatId} skipped: the message is ${Math.round(age / 60_000)} min old`)
    } else if (trigger) {
      void pager
        .page({
          source: trigger.source,
          senderKey: String(msg.from!.id),
          senderName: msg.from!.name,
          chatId: msg.chatId,
          chatLabel: describeMessage(store, msg).chatLabel,
          messageId: msg.id,
          reason: trigger.reason,
        })
        .then(r => log(r.ok ? `page ${r.page.id} (${trigger.source}) from ${msg.from!.id} in ${msg.chatId}` : `page from ${msg.from!.id} not sent: ${r.error}`))
    }
    void away.onIncoming(msg, trigger !== null)
    // Taking a chat off autoReply ends listening to it at once, even for existing watches. A chat
    // handed over with /reply is listened to for as long as the takeover lasts.
    if (!hub.takeoverOf(msg.chatId) && !isListed(store.get(), 'autoReply', msg.chat)) return
    const n = hub.dispatch(msg, m => describeMessage(store, m))
    if (n > 0) log(`message ${msg.chatId}:${msg.id} -> ${n} session(s)`)
  })
  tg.start()
  bot?.start()
  const pageTimer = setInterval(() => void pager.tick(), o.pageTickMs ?? 5_000)

  const timer = setInterval(() => {
    for (const sid of hub.sweep()) log(`session ${sid} expired, its watches are gone`)
    approvals.sweep()
  }, 30_000)

  return {
    port,
    token,
    store,
    tg,
    hub,
    pager,
    service,
    async stop() {
      clearInterval(timer)
      clearInterval(pageTimer)
      bot?.stop()
      server.stop(true)
      store.close()
      await tg.stop()
    },
  }
}

export async function runDaemon(): Promise<void> {
  const paths = getPaths()
  const log = makeLogger(paths)
  let daemon: Awaited<ReturnType<typeof createDaemon>>
  try {
    daemon = await createDaemon({ paths, port: getPort(), log })
  } catch (e) {
    log(`daemon failed to start: ${e instanceof Error ? e.message : e}`)
    process.exit(1)
  }
  log(`daemon up on 127.0.0.1:${daemon.port} (pid ${process.pid}), home ${paths.home}`)

  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping) return
    stopping = true
    log(`${signal}: shutting down`)
    // Closing the client cleanly saves the update state, so the next start catches up without duplicates.
    await Promise.race([daemon.stop(), new Promise(r => setTimeout(r, 8_000))])
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('uncaughtException', e => log(`uncaught: ${e.stack ?? e}`))
  process.on('unhandledRejection', e => log(`unhandled rejection: ${e instanceof Error ? e.stack : e}`))
}
