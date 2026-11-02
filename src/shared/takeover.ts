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

/**
 * Nothing the daemon sends may itself look like a command, or a chat could talk Claude into starting
 * a takeover. Checked on the text as Telegram will show it, so /reply in bold or behind html tags counts.
 */
export function looksLikeReplyCommand(text: string, parseMode: 'plain' | 'markdown' | 'html' = 'plain'): boolean {
  return /^\s*\/reply(?![a-z0-9])/i.test(visibleStart(text, parseMode))
}

/** The start of a message with formatting removed: enough to see what it opens with. */
function visibleStart(text: string, parseMode: 'plain' | 'markdown' | 'html'): string {
  if (parseMode === 'html') {
    return text
      .replace(/<[^>]*>/g, '')
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&sol;/gi, '/')
  }
  if (parseMode === 'markdown') return text.replace(/^[\s*_~`|[\]>\\]+/, '')
  return text
}
