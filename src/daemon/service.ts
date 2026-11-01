import { z } from 'zod'
import {
  RULE_LISTS,
  isListed,
  nicknameFor,
  normalizeNickname,
  normalizeUsername,
  resolveRef,
  rulesMentioning,
  validateNickname,
  type ChatEntry,
  type ChatRef,
  type ConfigStore,
} from '../shared/config'
import { decideSend, policyLabel, withFooter } from '../shared/policy'
import type { IncomingMessage, MessageInfo, PeerInfo, TgEvent, ToolResult } from '../shared/protocol'
import { TOOLS, isToolName, type ToolInput, type ToolName } from '../shared/tools'
import type { Approvals } from './approvals'
import { formatEvent, type SessionHub } from './sessions'
import type { TelegramPort } from './telegram'

export interface ServiceDeps {
  store: ConfigStore
  tg: TelegramPort
  hub: SessionHub
  approvals: Approvals
  /** The Monitor WebSocket url for a session. */
  eventsUrl: (sessionId: string) => string
}

interface Target {
  peer: PeerInfo
  nickname?: string
  entry?: ChatEntry
  label: string
  warning?: string
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const fail = (text: string): ToolResult => ({ text, isError: true })

export function fmtPeer(p: PeerInfo): string {
  return [p.name, p.username ? `@${p.username}` : null, `id ${p.id}`, p.type, p.isForum ? 'forum' : null]
    .filter(Boolean)
    .join(' · ')
}

function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

export function fmtMessage(m: MessageInfo): string {
  const who = m.outgoing ? 'me' : m.from ? (m.from.username ? `${m.from.name} (@${m.from.username})` : m.from.name) : 'unknown'
  const marks = [m.replyToId ? `reply to #${m.replyToId}` : null, m.topicId ? `topic ${m.topicId}` : null].filter(Boolean)
  const body = [m.media ? `[${m.media}]` : null, m.text].filter(Boolean).join(' ') || '[empty]'
  return `#${m.id} ${m.date.slice(0, 16).replace('T', ' ')} ${who}${marks.length ? ` (${marks.join(', ')})` : ''}: ${body}`
}

export function describeMessage(store: ConfigStore, msg: IncomingMessage): Omit<TgEvent, 'seq' | 'watchIds'> {
  return {
    chatId: msg.chatId,
    chatLabel: msg.chat.name,
    chatNickname: nicknameFor(store.get(), msg.chatId),
    fromId: msg.from?.id ?? null,
    fromName: msg.from?.name ?? 'unknown sender',
    fromUsername: msg.from?.username ?? null,
    messageId: msg.id,
    topicId: msg.topicId,
    replyToId: msg.replyToId,
    text: msg.text,
    media: msg.media,
    date: msg.date,
  }
}

type Handlers = { [N in ToolName]: (sessionId: string, p: ToolInput<N>) => Promise<ToolResult> }

/** The tools, independent of how they're reached. */
export class Service {
  constructor(private readonly d: ServiceDeps) {}

  async call(sessionId: string, method: string, params: unknown): Promise<ToolResult> {
    if (!isToolName(method)) return fail(`Unknown tool: ${method}`)
    const parsed = TOOLS[method].input.safeParse(params ?? {})
    if (!parsed.success) return fail(`Invalid arguments:\n${z.prettifyError(parsed.error)}`)
    try {
      const handler = this.#handlers[method] as (sid: string, p: unknown) => Promise<ToolResult>
      return await handler(sessionId, parsed.data)
    } catch (e) {
      return fail(errText(e))
    }
  }

  // ---- resolving chats -----------------------------------------------------------

  async #peerById(id: number): Promise<PeerInfo> {
    try {
      return await this.d.tg.getPeer(id)
    } catch {
      // A fresh session may not know this chat's access hash yet; loading dialogs teaches it.
      await this.d.tg.listDialogs({ limit: 200, unreadOnly: false })
      return await this.d.tg.getPeer(id)
    }
  }

  /** Looks up a saved entry and checks it still points where the file says. */
  async #verifyEntry(nickname: string, entry: ChatEntry, strict: boolean): Promise<Target> {
    let peer: PeerInfo
    try {
      peer = await this.#peerById(entry.id)
    } catch (e) {
      if (!entry.username) throw new Error(`Can't reach saved chat "${nickname}" (id ${entry.id}): ${errText(e)}`)
      peer = await this.d.tg.getPeer(entry.username)
    }
    if (peer.id !== entry.id) {
      throw new Error(
        `Saved chat "${nickname}" is id ${entry.id}, but @${entry.username} is now id ${peer.id} (${peer.name}). Not using it. Check who this is and re-save with telegram_save_chat (overwrite) or fix config.json.`,
      )
    }
    let warning: string | undefined
    if (entry.username && peer.username && normalizeUsername(entry.username) !== normalizeUsername(peer.username)) {
      const msg = `Saved chat "${nickname}" (id ${entry.id}) was @${entry.username}, but Telegram now says @${peer.username}.`
      if (strict) throw new Error(`${msg} Not sending until it's confirmed: re-save it with telegram_save_chat (overwrite: true) if it's still the right person.`)
      warning = msg
    }
    return { peer, nickname, entry, label: `${peer.name} [${nickname}]`, warning }
  }

  async #resolve(ref: ChatRef, strict: boolean): Promise<Target> {
    const r = resolveRef(this.d.store.get(), ref)
    switch (r.kind) {
      case 'entry':
        return this.#verifyEntry(r.nickname, r.entry, strict)
      case 'self': {
        const peer = await this.d.tg.getPeer('me')
        return { peer, label: 'Saved Messages' }
      }
      case 'id': {
        const peer = await this.#peerById(r.id)
        return { peer, label: peer.name }
      }
      case 'username': {
        const peer = await this.d.tg.getPeer(r.username)
        return { peer, label: `${peer.name} (@${peer.username ?? r.username})` }
      }
      case 'unknown': {
        const hint = r.suggestions.length ? ` Close matches: ${r.suggestions.join('; ')}.` : ''
        throw new Error(
          `No saved chat called "${r.query}".${hint} Ask the user which chat they mean, find it with telegram_search_chats, and save it with telegram_save_chat.`,
        )
      }
    }
  }

  // ---- delivery hint -------------------------------------------------------------------

  #delivery(sessionId: string): string {
    const { hub } = this.d
    if (hub.isChannel(sessionId)) return 'New messages arrive by themselves as <channel> events in this session.'
    if (hub.monitorCount(sessionId) > 0) return 'Your Monitor is connected: new messages show up as Monitor notifications.'
    return [
      'To be notified, start the Monitor tool with:',
      `  ws.url: ${this.d.eventsUrl(sessionId)}`,
      '  description: "Telegram watch", timeout_ms: 1800000',
      'Each message arrives as one notification. When the Monitor expires, start it again with the same url (nothing is lost meanwhile: messages queue up).',
      'Without a Monitor, telegram_get_events collects whatever arrived.',
    ].join('\n')
  }

  // ---- tools -------------------------------------------------------------------------

  #handlers: Handlers = {
    telegram_status: async sid => {
      const { tg, hub, store } = this.d
      const st = tg.state()
      const lines = [
        `Telegram: ${st.phase}${st.me ? ` as ${fmtPeer(st.me)}` : ''} (since ${new Date(st.since).toISOString()}, ${st.reconnects} reconnects)`,
      ]
      if (st.lastError && st.phase !== 'connected') lines.push(`Last error: ${st.lastError}`)
      lines.push(`Config: ${store.path}${store.error() ? `\n  ${store.error()}` : ''}`)
      const watches = hub.watches(sid)
      lines.push(`This session: ${sid}`)
      lines.push(
        `Delivery: ${hub.isChannel(sid) ? 'channel push' : hub.monitorCount(sid) > 0 ? 'Monitor connected' : 'nothing listening (messages queue up)'}`,
      )
      lines.push(watches.length ? 'Watches:' : 'Watches: none')
      for (const w of watches) {
        lines.push(
          `  ${w.id}: ${w.chatLabel}${w.fromLabel ? `, only from ${w.fromLabel}` : ''}${w.topicId ? `, topic ${w.topicId}` : ''}${w.note ? ` (${w.note})` : ''}`,
        )
      }
      if (watches.length && !hub.isChannel(sid) && hub.monitorCount(sid) === 0) lines.push(this.#delivery(sid))
      return { text: lines.join('\n') }
    },

    telegram_get_rules: async () => {
      const c = this.d.store.get()
      const name = (ref: ChatRef) => {
        const r = resolveRef(c, ref)
        if (r.kind === 'entry') return `${r.nickname} (id ${r.entry.id}${r.entry.username ? `, @${r.entry.username}` : ''})`
        if (r.kind === 'unknown') return `${ref} (not a saved nickname: matches nothing)`
        return String(ref)
      }
      const out = ['Guides:', ...(c.guides.length ? c.guides.map(g => `- ${g}`) : ['- (none)'])]
      out.push('', `Footer added to every message: ${c.footer.trim() ? JSON.stringify(c.footer) : '(none)'}`)
      out.push(`Chats in no list: ${c.defaultPolicy === 'block' ? 'blocked' : 'need approval'}`)
      for (const list of RULE_LISTS) {
        out.push(`${list}: ${c.rules[list].length ? c.rules[list].map(name).join(', ') : '(empty)'}`)
      }
      out.push('', 'Saved chats:')
      const entries = Object.entries(c.chats)
      if (entries.length === 0) out.push('  (none yet)')
      for (const [nick, e] of entries) {
        const bits = [
          `id ${e.id}`,
          e.username ? `@${e.username}` : null,
          e.name,
          e.type,
          e.topicId ? `topic ${e.topicId}` : null,
          e.aliases.length ? `aliases: ${e.aliases.join(', ')}` : null,
          policyLabel(c, { id: e.id, username: e.username }),
          e.notes ? `notes: ${e.notes}` : null,
        ].filter(Boolean)
        out.push(`  ${nick}: ${bits.join(' · ')}`)
      }
      if (this.d.store.error()) out.push('', this.d.store.error()!)
      return { text: out.join('\n') }
    },

    telegram_list_chats: async (_sid, p) => {
      const c = this.d.store.get()
      const dialogs = await this.d.tg.listDialogs(p)
      if (dialogs.length === 0) return { text: p.unreadOnly ? 'No unread chats.' : 'No chats.' }
      const lines = dialogs.map(d => {
        const nick = nicknameFor(c, d.peer.id)
        const last = d.lastMessage ? ` · last: ${d.lastMessage.outgoing ? 'me: ' : ''}"${clip(d.lastMessage.text || '[media]', 60)}"` : ''
        return `• ${fmtPeer(d.peer)}${nick ? ` · [${nick}]` : ''}${d.unread ? ` · ${d.unread} unread` : ''} · ${policyLabel(c, d.peer)}${last}`
      })
      return { text: lines.join('\n') }
    },

    telegram_search_chats: async (_sid, p) => {
      const c = this.d.store.get()
      const found = await this.d.tg.searchChats(p.query, p.limit)
      if (found.length === 0) return { text: `Nothing found for "${p.query}".` }
      return {
        text: found
          .map(f => {
            const nick = nicknameFor(c, f.id)
            return `• ${fmtPeer(f)}${nick ? ` · saved as "${nick}"` : ''}${f.global ? ' · public result, not in your chats' : ''}`
          })
          .join('\n'),
      }
    },

    telegram_read_messages: async (_sid, p) => {
      const t = await this.#resolve(p.chat, false)
      const topicId = p.topicId ?? t.entry?.topicId
      const msgs = await this.d.tg.getHistory(t.peer.id, { limit: p.limit, beforeId: p.beforeId, topicId })
      const head = `${t.label} · ${fmtPeer(t.peer)}${topicId ? ` · topic ${topicId}` : ''}`
      const lines = [head, ...(t.warning ? [`Warning: ${t.warning}`] : []), ...msgs.map(fmtMessage)]
      if (msgs.length === 0) lines.push('(no messages)')
      return { text: lines.join('\n') }
    },

    telegram_send_message: async (sid, p) => {
      const config = this.d.store.get()
      const t = await this.#resolve(p.to, true)
      const topicId = p.topicId ?? t.entry?.topicId
      const decision = decideSend(config, t.peer, { isWatching: this.d.hub.isWatching(sid, t.peer.id) })
      if (decision.action === 'block') return fail(`Not sent to ${t.label}: ${decision.reason}.`)
      const text = withFooter(p.text, config.footer)
      if (decision.action === 'send') {
        const sent = await this.d.tg.sendText(t.peer.id, text, { replyTo: p.replyTo, topicId, parseMode: p.parseMode })
        return { text: `Sent to ${t.label} (message #${sent.id}${topicId ? `, topic ${topicId}` : ''}). Allowed because ${decision.reason}.` }
      }
      const pending = this.d.approvals.create({
        sessionId: sid,
        chatId: t.peer.id,
        chatLabel: `${t.label} · ${fmtPeer(t.peer)}`,
        username: t.peer.username,
        text,
        replyTo: p.replyTo,
        topicId,
        parseMode: p.parseMode,
        reason: decision.reason,
      })
      return {
        text: [
          `Not sent yet: needs the user's approval (${decision.reason}). Approval id: ${pending.id}`,
          `To: ${pending.chatLabel}${topicId ? ` · topic ${topicId}` : ''}`,
          'Message:',
          text,
          '',
          'Show the user this exact message and recipient. Only if they say yes, call telegram_confirm_send with the approval id; otherwise telegram_cancel_send.',
        ].join('\n'),
        approval: { id: pending.id, to: pending.chatLabel, text, reason: decision.reason },
      }
    },

    telegram_confirm_send: async (sid, p) => {
      const item = this.d.approvals.take(p.approvalId, sid)
      // The rules may have changed since the draft was made.
      const decision = decideSend(this.d.store.get(), { id: item.chatId, username: item.username }, { isWatching: false })
      if (decision.action === 'block') return fail(`Not sent to ${item.chatLabel}: ${decision.reason}.`)
      const sent = await this.d.tg.sendText(item.chatId, item.text, {
        replyTo: item.replyTo,
        topicId: item.topicId,
        parseMode: item.parseMode,
      })
      return { text: `Sent to ${item.chatLabel} (message #${sent.id}).` }
    },

    telegram_cancel_send: async (sid, p) => {
      const item = this.d.approvals.take(p.approvalId, sid)
      return { text: `Dropped the draft to ${item.chatLabel}. Nothing was sent.` }
    },

    telegram_save_chat: async (_sid, p) => {
      const problem = validateNickname(p.nickname)
      if (problem) return fail(problem)
      const nick = normalizeNickname(p.nickname)
      const config = this.d.store.get()

      const r = resolveRef(config, p.chat)
      let peer: PeerInfo
      if (r.kind === 'entry') peer = (await this.#verifyEntry(r.nickname, r.entry, true)).peer
      else if (r.kind === 'id') peer = await this.#peerById(r.id)
      else if (r.kind === 'username') peer = await this.d.tg.getPeer(r.username)
      else if (r.kind === 'self') peer = await this.d.tg.getPeer('me')
      else return fail(`"${r.query}" isn't an @username, id or saved nickname. Use telegram_search_chats to find the chat first.`)

      const existing = config.chats[nick]
      if (existing && existing.id !== peer.id && !p.overwrite) {
        return fail(`"${nick}" already points to ${existing.name ?? 'a chat'} (id ${existing.id}). Pass overwrite: true to repoint it at ${peer.name}.`)
      }
      // Rules refer to chats by nickname. Letting a session repoint or create a name the rules
      // already use would let it move "autoSend" (or out of "blocked") to a different chat.
      const names = [nick, ...(p.aliases ?? [])]
      for (const name of names) {
        const lists = rulesMentioning(config, name)
        const current = resolveRef(config, name)
        const samePeer = current.kind === 'entry' && current.entry.id === peer.id
        if (lists.length && !samePeer) {
          return fail(`"${name}" is used in rules (${lists.join(', ')}), so only a human can point it at a chat: edit ${this.d.store.path}.`)
        }
      }
      for (const alias of p.aliases ?? []) {
        const clash = resolveRef(config, alias)
        if (clash.kind === 'entry' && clash.entry.id !== peer.id && normalizeNickname(clash.nickname) !== nick) {
          return fail(`Alias "${alias}" already means ${clash.nickname} (id ${clash.entry.id}).`)
        }
      }

      const entry: ChatEntry = {
        ...(existing ?? {}),
        id: peer.id,
        username: peer.username,
        name: peer.name,
        type: peer.type,
        aliases: p.aliases ?? existing?.aliases ?? [],
        ...(p.topicId !== undefined ? { topicId: p.topicId } : {}),
        ...(p.notes !== undefined ? { notes: p.notes } : {}),
      }
      const saved = this.d.store.update(c => {
        c.chats[nick] = entry
      })
      const others = Object.entries(saved.chats).filter(([n, e]) => n !== nick && e.id === peer.id).map(([n]) => n)
      return {
        text: `Saved "${nick}" → ${fmtPeer(peer)}${entry.topicId ? ` · topic ${entry.topicId}` : ''}. Sending there: ${policyLabel(saved, peer)}.${others.length ? ` (Also saved as: ${others.join(', ')}.)` : ''}`,
      }
    },

    telegram_remove_chat: async (_sid, p) => {
      const nick = normalizeNickname(p.nickname)
      const config = this.d.store.get()
      if (!config.chats[nick]) return fail(`No saved chat called "${nick}".`)
      const names = [nick, ...config.chats[nick]!.aliases]
      const used = names.flatMap(n => rulesMentioning(config, n).map(l => `${n} in ${l}`))
      if (used.length) return fail(`"${nick}" is used in rules (${used.join(', ')}); only a human can remove it, by editing ${this.d.store.path}.`)
      this.d.store.update(c => {
        delete c.chats[nick]
      })
      return { text: `Removed "${nick}".` }
    },

    telegram_watch: async (sid, p) => {
      const t = await this.#resolve(p.chat, false)
      const from = p.from !== undefined ? await this.#resolve(p.from, false) : undefined
      const topicId = p.topicId ?? t.entry?.topicId
      const w = this.d.hub.addWatch(sid, {
        chatId: t.peer.id,
        chatLabel: t.label,
        ...(from ? { fromId: from.peer.id, fromLabel: from.label } : {}),
        ...(topicId !== undefined ? { topicId } : {}),
        ...(p.note ? { note: p.note } : {}),
      })
      const config = this.d.store.get()
      const replies = isListed(config, 'autoReply', t.peer) && !isListed(config, 'requireApproval', t.peer) && !isListed(config, 'blocked', t.peer)
        ? 'This chat is on autoReply: your replies there go out without asking while this watch is on.'
        : `Replies there follow the normal rules: ${policyLabel(config, t.peer)}.`
      return {
        text: [
          `Watching ${t.label}${from ? `, only messages from ${from.label}` : ''}${topicId ? `, topic ${topicId}` : ''}. Watch id: ${w.id}.`,
          replies,
          this.#delivery(sid),
          'Stop with telegram_unwatch when the user says so.',
        ].join('\n'),
      }
    },

    telegram_unwatch: async (sid, p) => {
      if (p.all) return { text: `Stopped ${this.d.hub.clearWatches(sid)} watch(es).` }
      if (!p.watchId) return fail('Pass watchId, or all: true.')
      return this.d.hub.removeWatch(sid, p.watchId)
        ? { text: `Stopped watch ${p.watchId}.` }
        : fail(`This session has no watch ${p.watchId}.`)
    },

    telegram_get_events: async sid => {
      const { events, dropped } = this.d.hub.drain(sid)
      if (events.length === 0) return { text: dropped ? `${dropped} older messages were dropped (queue full).` : 'No new watched messages.' }
      const parts = events.map(formatEvent)
      if (dropped) parts.unshift(`(${dropped} older messages were dropped because the queue was full.)`)
      return { text: parts.join('\n\n') }
    },

    telegram_mark_read: async (_sid, p) => {
      const t = await this.#resolve(p.chat, false)
      await this.d.tg.markRead(t.peer.id)
      return { text: `Marked ${t.label} as read.` }
    },
  }
}
