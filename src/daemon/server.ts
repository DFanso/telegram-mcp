import { timingSafeEqual } from 'node:crypto'
import type { ServerWebSocket } from 'bun'
import type { ConfigStore } from '../shared/config'
import type { ClientMessage, ServerMessage } from '../shared/protocol'
import type { Service } from './service'
import type { SessionHub } from './sessions'
import type { TelegramPort } from './telegram'

interface WsData {
  kind: 'bridge' | 'events'
  sessionId: string | null
}

export interface ServerOptions {
  port: number
  token: string
  service: Service
  hub: SessionHub
  tg: TelegramPort
  store: ConfigStore
  log: (msg: string) => void
  startedAt: number
}

function sameToken(given: string | null, token: string): boolean {
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Localhost only. Everything except /health needs the token from the token file, which also
 * keeps web pages in a browser (which can reach 127.0.0.1) from reading your messages.
 *
 *   GET  /health             liveness, no auth
 *   GET  /status             JSON status
 *   POST /admin/reconnect    rebuild the Telegram client (used after `tgmcp login`)
 *   WS   /bridge             one per Claude session: the MCP proxy's tool calls and pushes
 *   WS   /events?session=ID  Monitor stream: one text frame per watched message
 */
export function startServer(o: ServerOptions) {
  const send = (ws: ServerWebSocket<WsData>, msg: ServerMessage) => ws.send(JSON.stringify(msg))

  return Bun.serve<WsData>({
    hostname: '127.0.0.1',
    port: o.port,
    fetch(req, server) {
      const url = new URL(req.url)
      if (url.pathname === '/health') return Response.json({ ok: true, service: 'telegram-mcp' })

      const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null
      if (!sameToken(bearer ?? url.searchParams.get('token'), o.token)) return new Response('unauthorized\n', { status: 401 })

      if (url.pathname === '/bridge') {
        return server.upgrade(req, { data: { kind: 'bridge', sessionId: null } })
          ? undefined
          : new Response('expected a websocket\n', { status: 400 })
      }
      if (url.pathname === '/events') {
        const sid = url.searchParams.get('session')
        if (!sid || !o.hub.has(sid)) return new Response('unknown session (is the Claude session still running?)\n', { status: 404 })
        return server.upgrade(req, { data: { kind: 'events', sessionId: sid } })
          ? undefined
          : new Response('expected a websocket\n', { status: 400 })
      }
      if (url.pathname === '/status' && req.method === 'GET') {
        return Response.json({
          pid: process.pid,
          startedAt: new Date(o.startedAt).toISOString(),
          telegram: o.tg.state(),
          config: { path: o.store.path, error: o.store.error() },
          sessions: o.hub.summary(),
        })
      }
      if (url.pathname === '/admin/reconnect' && req.method === 'POST') {
        void o.tg.reconnect('requested over http')
        return Response.json({ ok: true })
      }
      return new Response('not found\n', { status: 404 })
    },
    websocket: {
      idleTimeout: 120,
      sendPings: true,
      open(ws) {
        if (ws.data.kind === 'events' && ws.data.sessionId && !o.hub.attachMonitor(ws.data.sessionId, ws)) {
          ws.close(4004, 'unknown session')
        }
      },
      message(ws, raw) {
        if (ws.data.kind !== 'bridge') return
        let msg: ClientMessage
        try {
          msg = JSON.parse(String(raw)) as ClientMessage
        } catch {
          return
        }
        if (msg.t === 'hello') {
          ws.data.sessionId = msg.sessionId
          o.hub.attachProxy(msg.sessionId, { label: msg.label, channel: msg.channel, watches: msg.watches ?? [] }, ws)
          send(ws, { t: 'welcome', telegram: o.tg.state() })
          o.log(`session ${msg.sessionId} connected (${msg.label}${msg.channel ? ', channel' : ''})`)
          return
        }
        if (msg.t === 'call') {
          const sid = ws.data.sessionId
          if (!sid) {
            send(ws, { t: 'result', id: msg.id, ok: false, error: 'say hello first' })
            return
          }
          o.service
            .call(sid, msg.method, msg.params)
            .then(result => send(ws, { t: 'result', id: msg.id, ok: true, result, pending: o.hub.pending(sid) }))
            .catch(e => send(ws, { t: 'result', id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) }))
        }
      },
      close(ws) {
        const sid = ws.data.sessionId
        if (!sid) return
        if (ws.data.kind === 'bridge') {
          o.hub.detachProxy(sid, ws)
          o.log(`session ${sid} disconnected`)
        } else {
          o.hub.detachMonitor(sid, ws)
        }
      },
    },
  })
}
