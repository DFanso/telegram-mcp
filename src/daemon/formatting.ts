import { html, md } from '@mtcute/bun'

export type ParseMode = 'plain' | 'markdown' | 'html'

/** Text in the form mtcute sends it: parsed for markdown and html, untouched for plain. */
export function formatted(text: string, parseMode: ParseMode = 'plain') {
  return parseMode === 'markdown' ? md(text) : parseMode === 'html' ? html(text) : text
}

/**
 * What the recipient will read, formatting and entities gone. Built on the same parsers the
 * sends use, so a check on it sees exactly what Telegram will show. Text that does not parse
 * is returned as is: it could not be sent either.
 */
export function visibleText(text: string, parseMode: ParseMode = 'plain'): string {
  try {
    const f = formatted(text, parseMode)
    return typeof f === 'string' ? f : f.text
  } catch {
    return text
  }
}
