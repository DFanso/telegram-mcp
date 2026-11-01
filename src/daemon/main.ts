import { ConfigStore } from '../shared/config'
import { ensureHome, ensureToken, loadCredentials, makeLogger } from '../shared/files'
import { getPaths, getPort, type Paths } from '../shared/paths'
import { Approvals } from './approvals'
import { startServer } from './server'
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
}

export async function createDaemon(o: DaemonOptions) {
  const log = o.log ?? makeLogger(o.paths)
  const startedAt = Date.now()
  ensureHome(o.paths)
  const token = ensureToken(o.paths)
  const store = new ConfigStore(o.paths.config, log)
  const tg =
    o.telegram ??
    new MtcuteTelegram({ sessionPath: o.paths.session, loadCredentials: () => loadCredentials(o.paths), log })
  const hub = new SessionHub({ log, ...o.hub })
  const approvals = new Approvals()

  let port = o.port
  const service = new Service({
    store,
    tg,
    hub,
    approvals,
    eventsUrl: sid => `ws://127.0.0.1:${port}/events?session=${sid}&token=${token}`,
  })

  // Bind first: if another daemon already owns the port, fail before touching the Telegram session.
  const server = startServer({ port: o.port, token, service, hub, tg, store, log, startedAt })
  port = server.port ?? o.port
  store.watch()

  tg.onMessage(msg => {
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
