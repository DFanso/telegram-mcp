/** "/reply" typed by the account owner in any chat hands that chat to a Claude session. */

export type ReplyCommand = { action: 'start'; instruction: string } | { action: 'stop' }

/** Matches "/reply", "/reply <what to say or how>", and "/reply stop" (also "/reply@bot …"). */
export function parseReplyCommand(text: string): ReplyCommand | null {
  const m = /^\/reply(?:@\S+)?(?:\s+([\s\S]*))?$/i.exec(text.trim())
  if (!m) return null
  const rest = (m[1] ?? '').trim()
  if (/^(stop|off|end|done)$/i.test(rest)) return { action: 'stop' }
  return { action: 'start', instruction: rest }
}

/** Nothing the daemon sends may itself look like a command, or a chat could talk Claude into starting a takeover. */
export function looksLikeReplyCommand(text: string): boolean {
  return /^\s*\/reply\b/i.test(text)
}
