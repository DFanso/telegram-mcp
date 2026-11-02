import type { PeerType } from './config'

// ---- Telegram data as the daemon hands it around ---------------------------------

export interface PeerInfo {
  id: number
  type: PeerType
  name: string
  username: string | null
  isSelf?: boolean
  isForum?: boolean
}

export interface MessageInfo {
  id: number
  chatId: number
  date: string
  from: PeerInfo | null
  outgoing: boolean
  text: string
  media: string | null
  replyToId: number | null
  topicId: number | null
}

/** A message's attachment saved to disk. */
export interface DownloadedFile {
  path: string
  name: string
  size: number
  mime: string | null
}

export interface IncomingMessage extends MessageInfo {
  chat: PeerInfo
}

export interface DialogInfo {
  peer: PeerInfo
  unread: number
  pinned: boolean
  lastMessage: { id: number; date: string; text: string; outgoing: boolean } | null
}

export type ConnectionPhase = 'starting' | 'connecting' | 'connected' | 'logged_out' | 'no_credentials'

export interface TelegramState {
  phase: ConnectionPhase
  me: PeerInfo | null
  since: number
  reconnects: number
  lastError: string | null
}

// ---- watches and the events they produce -----------------------------------------

export interface WatchSpec {
  id: string
  chatId: number
  chatLabel: string
  fromId?: number
  fromLabel?: string
  topicId?: number
  note?: string
  createdAt: number
}

export interface TgEvent {
  seq: number
  watchIds: string[]
  chatId: number
  chatLabel: string
  chatNickname?: string
  fromId: number | null
  fromName: string
  fromUsername: string | null
  messageId: number
  topicId: number | null
  replyToId: number | null
  text: string
  media: string | null
  date: string
}

// ---- tool results ------------------------------------------------------------------

export interface ApprovalRequest {
  id: string
  to: string
  text: string
  reason: string
  /** The menu bar app is running, so the decision is made there. */
  uiActive: boolean
  /** First message to a chat on neither autoSend nor requireApproval: the approver also picks which list it joins. */
  firstTime: boolean
  nickname: string | null
  suggestedNickname: string
}

// ---- what the menu bar app shows ----------------------------------------------------

export interface SentRecord {
  at: string
  chatId: number
  chatLabel: string
  text: string
  messageId: number
  /** auto = allowed by the rules; menubar / dialog / chat = approved there. */
  via: 'auto' | 'menubar' | 'dialog' | 'chat'
  sessionLabel: string | null
}

export interface UiApproval {
  id: string
  to: string
  detail: string
  text: string
  reason: string
  sessionId: string
  sessionLabel: string
  createdAt: string
  expiresAt: string
  firstTime: boolean
  nickname: string | null
  suggestedNickname: string
}

export interface UiSession {
  id: string
  label: string
  connected: boolean
  channel: boolean
  monitors: number
  pending: number
  watches: WatchSpec[]
}

/**
 * Which sending list decides a chat, the safest one winning as in the policy:
 * blocked > requireApproval > autoSend. `none` = in none of them, so defaultPolicy applies.
 */
export type SendMode = 'autoSend' | 'requireApproval' | 'blocked' | 'none'

/** A saved chat (`chats` in the rules file) and the rules that apply to it, for the Contacts page. */
export interface UiContact {
  nickname: string
  chatId: number
  name: string | null
  username: string | null
  type: PeerType | null
  topicId: number | null
  aliases: string[]
  notes: string | null
  sendMode: SendMode
  /** On the autoReply list: sessions may watch it and reply without asking while they do. */
  autoReply: boolean
  /** What sending there does now, in words (the same label telegram_get_rules shows). */
  policy: string
  /** Other nicknames saved for the same chat. Rules are per chat, so they change together. */
  sameChat: string[]
}

export interface UiState {
  telegram: TelegramState
  configError: string | null
  footer: string
  defaultPolicy: 'approve' | 'block'
  approvals: UiApproval[]
  sessions: UiSession[]
  recent: SentRecord[]
  contacts: UiContact[]
}

export interface ToolResult {
  text: string
  isError?: boolean
  /** Set when a send is waiting for a human yes. */
  approval?: ApprovalRequest
}

// ---- bridge protocol: per-session MCP proxy <-> daemon, JSON over one WebSocket ----

export type ClientMessage =
  | { t: 'hello'; sessionId: string; label: string; channel: boolean; watches: WatchSpec[] }
  | { t: 'call'; id: number; method: string; params: unknown }

export type ServerMessage =
  | { t: 'welcome'; telegram: TelegramState }
  | { t: 'result'; id: number; ok: true; result: ToolResult; pending: number }
  | { t: 'result'; id: number; ok: false; error: string }
  | { t: 'event'; event: TgEvent }
  | { t: 'watches'; watches: WatchSpec[] }
