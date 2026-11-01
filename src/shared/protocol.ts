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
