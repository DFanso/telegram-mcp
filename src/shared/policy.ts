import { isListed, type Config } from './config'

export type Decision =
  | { action: 'send'; reason: string }
  | { action: 'approve'; reason: string }
  | { action: 'block'; reason: string }

/**
 * Who may send where. Order matters and the safer answer wins:
 * blocked > requireApproval > autoSend > autoReply (only while watching) > defaultPolicy.
 *
 * A file to a chat the session is watching always asks, even on autoSend: while watching, the
 * session acts on what people in that chat write, so "send me that file" may be their request,
 * not yours. This only turns a "send" into an "approve"; it never loosens anything.
 */
export function decideSend(
  config: Config,
  chat: { id: number; username?: string | null },
  ctx: { isWatching: boolean; file?: boolean; takenOver?: boolean },
): Decision {
  const d = decideText(config, chat, ctx)
  if (d.action === 'send' && ctx.file && (ctx.isWatching || ctx.takenOver)) {
    return { action: 'approve', reason: 'files to a chat this session is watching always need approval (the request may have come from that chat)' }
  }
  return d
}

function decideText(
  config: Config,
  chat: { id: number; username?: string | null },
  ctx: { isWatching: boolean; takenOver?: boolean },
): Decision {
  if (isListed(config, 'blocked', chat)) return { action: 'block', reason: 'this chat is on the blocked list' }
  // The owner typed /reply in this very chat: that is a yes for this chat, for as long as the takeover lasts.
  if (ctx.takenOver) return { action: 'send', reason: 'the user handed this chat over with /reply' }
  if (isListed(config, 'requireApproval', chat))
    return { action: 'approve', reason: 'this chat is on the requireApproval list' }
  if (isListed(config, 'autoSend', chat)) return { action: 'send', reason: 'this chat is on the autoSend list' }
  if (isListed(config, 'autoReply', chat)) {
    return ctx.isWatching
      ? { action: 'send', reason: 'autoReply chat that this session is watching' }
      : { action: 'approve', reason: 'autoReply chats only send without asking while this session watches them' }
  }
  return config.defaultPolicy === 'block'
    ? { action: 'block', reason: 'this chat is in no list and defaultPolicy is "block"' }
    : { action: 'approve', reason: 'this chat is in no list, so it needs approval (defaultPolicy "approve")' }
}

/** Short label for listings: what would happen if a session sent here now. */
export function policyLabel(config: Config, chat: { id: number; username?: string | null }): string {
  if (isListed(config, 'blocked', chat)) return 'blocked'
  if (isListed(config, 'requireApproval', chat)) return 'needs approval'
  if (isListed(config, 'autoSend', chat)) return 'auto-send'
  if (isListed(config, 'autoReply', chat)) return 'auto-reply while watched'
  return config.defaultPolicy === 'block' ? 'blocked (default)' : 'needs approval (default)'
}

/** Appends the footer once. Text that already ends with it is left alone. */
export function withFooter(text: string, footer: string): string {
  const mark = footer.trim()
  if (mark === '') return text
  const body = text.trimEnd()
  if (body.endsWith(mark)) return body
  return body + footer
}
