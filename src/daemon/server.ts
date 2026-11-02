import { createHmac, timingSafeEqual } from 'node:crypto'
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
  /** Shown in /status. */
  secrets: { kind: string; where: string }
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
 * The key in a Monitor URL. It opens that one session's event stream and nothing else, so the
 * URL (which the model sees, and Claude Code keeps in its transcripts) never carries the token.
 */
export function eventsKey(token: string, sessionId: string): string {
  return createHmac('sha256', token).update(`events:${sessionId}`).digest('hex').slice(0, 32)
}

/**
 * Localhost only. Everything except /health needs the token (kept in the OS keystore), which
 * also keeps web pages in a browser (which can reach 127.0.0.1) from reading your messages.
 * /events also takes its session's own key instead (see eventsKey).
 *
 *   GET  /health                 liveness, no auth
 *   GET  /status                 JSON status
 *   POST /admin/reconnect        rebuild the Telegram client (used after `tgmcp login`)
 *   GET  /ui/state               what the menu bar app shows
 *   POST /ui/approvals/:id       {"decision": "approve" | "deny", "remember"?: "autoSend" | "requireApproval", "nickname"?: "…"}
 *   WS   /bridge                 one per Claude session: the MCP proxy's tool calls and pushes
 *   WS   /events?session=ID&key=K  Monitor stream: one text frame per watched message
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
      const authed = sameToken(bearer ?? url.searchParams.get('token'), o.token)

      if (url.pathname === '/events') {
        const sid = url.searchParams.get('session')
        if (!sid || !/^s_[a-z0-9]{8}$/.test(sid)) {
          return new Response(authed ? 'bad session id\n' : 'unauthorized\n', { status: authed ? 400 : 401 })
        }
        if (!authed && !sameToken(url.searchParams.get('key'), eventsKey(o.token, sid))) {
          return new Response('unauthorized\n', { status: 401 })
        }
        return server.upgrade(req, { data: { kind: 'events', sessionId: sid } })
          ? undefined
          : new Response('expected a websocket\n', { status: 400 })
      }
      if (!authed) return new Response('unauthorized\n', { status: 401 })

      if (url.pathname === '/bridge') {
        return server.upgrade(req, { data: { kind: 'bridge', sessionId: null } })
          ? undefined
          : new Response('expected a websocket\n', { status: 400 })
      }
      if (url.pathname === '/ui/state' && req.method === 'GET') {
        o.service.touchUi()
        return Response.json(o.service.uiState())
      }
      const decision = /^\/ui\/approvals\/([\w-]+)$/.exec(url.pathname)
      if (decision && req.method === 'POST') {
        return (async () => {
          const body = (await req.json().catch(() => ({}))) as { decision?: unknown; remember?: unknown; nickname?: unknown }
          if (body.decision !== 'approve' && body.decision !== 'deny') {
            return Response.json({ ok: false, text: 'decision must be "approve" or "deny"' }, { status: 400 })
          }
          const remember = body.remember === 'autoSend' || body.remember === 'requireApproval' ? body.remember : undefined
          const nickname = typeof body.nickname === 'string' ? body.nickname : undefined
          try {
            const r = await o.service.decide(decision[1]!, body.decision === 'approve', 'menubar', null, { remember, nickname })
            return Response.json({ ok: !r.isError, text: r.text }, { status: r.isError ? 409 : 200 })
          } catch (e) {
            return Response.json({ ok: false, text: e instanceof Error ? e.message : String(e) }, { status: 409 })
          }
        })()
      }
      if (url.pathname === '/status' && req.method === 'GET') {
        return Response.json({
          pid: process.pid,
          startedAt: new Date(o.startedAt).toISOString(),
          telegram: o.tg.state(),
          config: { path: o.store.path, error: o.store.error() },
          secrets: o.secrets,
          menubar: o.service.uiActive(),
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
        if (ws.data.kind === 'events' && ws.data.sessionId) o.hub.attachMonitor(ws.data.sessionId, ws)
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
