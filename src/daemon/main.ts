import { join } from 'node:path'
import { ConfigStore, isListed } from '../shared/config'
import { ensureHome, makeLogger } from '../shared/files'
import { getPaths, getPort, type Paths } from '../shared/paths'
import { ensureToken, loadCredentials, openSecretStore, type SecretStore } from '../shared/secrets'
import { Approvals } from './approvals'
import { eventsKey, startServer } from './server'
import { openSessionStorage } from './session-store'
import { Service, describeMessage } from './service'
import { SessionHub, type HubOptions } from './sessions'
import { MtcuteTelegram, type TelegramPort } from './telegram'

export interface DaemonOptions {
  paths: Paths
  port: number
  /** Inject a fake in tests; defaults to the real mtcute client. */
  telegram?: TelegramPort
  hub?: HubOptions
  log?: (msg: string) => void
  /** Defaults to the OS keystore (or files with TELEGRAM_MCP_SECRET_STORE=file). */
  secrets?: SecretStore
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
    log,
    startedAt,
  })
  port = server.port ?? o.port
  store.watch()

  tg.onMessage(msg => {
    // Taking a chat off autoReply ends listening to it at once, even for existing watches.
    if (!isListed(store.get(), 'autoReply', msg.chat)) return
    const n = hub.dispatch(msg, m => describeMessage(store, m))
    if (n > 0) log(`message ${msg.chatId}:${msg.id} -> ${n} session(s)`)
  })
  tg.start()

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
    async stop() {
      clearInterval(timer)
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
