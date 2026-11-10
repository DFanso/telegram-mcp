/**
 * Moderator commands: "/bots stop" and "/bots resume" from a moderator pause what Claude sessions on
 * this account do in a chat (or everywhere). A fixed set of commands, parsed here, before anything
 * reaches a session: nothing a moderator types becomes an instruction to Claude.
 */
import type { Config } from './config'
import type { IncomingMessage } from './protocol'

/**
 * Leo (@dfansoo) and Iddhi (@iddhi7), by user id: a username or display name can change hands. Only
 * used once the owner turns moderator commands on (`tgmcp bots on`); they are off by default.
 */
export const DEFAULT_MODERATORS: readonly number[] = [1188107983, 1269534379]

export type BotsCommand = { action: 'stop'; all: boolean; minutes: number | null } | { action: 'resume'; all: boolean }

/**
 * The whole message must be one of: "/bots stop", "/bots stop 30m", "/bots stop 2h", "/bots stop all",
 * "/bots stop all 2h", "/bots resume", "/bots resume all" (any letter case, extra spaces allowed).
 * Anything more, less or different is just a message: "/bots@x stop", "/botsstop", "/bots stop now".
 */
export function parseBotsCommand(text: string): BotsCommand | null {
  const m = /^\/bots[ \t]+(stop|resume)(?:[ \t]+(all))?(?:[ \t]+(\d{1,4})(m|h))?$/i.exec(text.trim())
  if (!m) return null
  const all = m[2] !== undefined
  if (m[1]!.toLowerCase() === 'resume') return m[3] === undefined ? { action: 'resume', all } : null
  if (m[3] === undefined) return { action: 'stop', all, minutes: null }
  const n = Number(m[3])
  const minutes = m[4]!.toLowerCase() === 'h' ? n * 60 : n
  return minutes >= 1 ? { action: 'stop', all, minutes } : null
}

/**
 * A /bots command that counts here: moderator commands are on, a moderator sent it (by user id), and
 * this account is not a moderator itself (moderators' own sessions never obey them). A forward or a
 * caption on a photo or file is never a command: the moderator has to type it.
 */
export function moderatorCommand(config: Config, msg: IncomingMessage, meId: number | null | undefined): BotsCommand | null {
  const { moderation } = config
  if (!moderation.enabled || msg.outgoing || !msg.from || meId == null) return null
  if (msg.forwarded || msg.media !== null) return null
  if (msg.from.id === meId || !moderation.moderators.includes(msg.from.id) || moderation.moderators.includes(meId)) return null
  return parseBotsCommand(msg.text)
}

/** How long a stop lasts: what the moderator asked for, else defaultMinutes, never more than maxMinutes. */
export function stopMinutes(config: Config, cmd: { minutes: number | null }): number {
  const { defaultMinutes, maxMinutes } = config.moderation
  return Math.min(cmd.minutes ?? defaultMinutes, maxMinutes)
}

/** A session never sends a /bots command: a moderator's own Claude can't be talked into "/bots resume". */
export function looksLikeBotsCommand(text: string): boolean {
  return /^\s*\/bots(?![a-z0-9_])/i.test(text)
}

/** "45 min", "1h", "1h 30m": what's left, rounded up to the minute. */
export function fmtMinutes(ms: number): string {
  const total = Math.max(1, Math.ceil(ms / 60_000))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}
