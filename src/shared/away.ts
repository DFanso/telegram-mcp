import { z } from 'zod'

/**
 * Away auto-reply: the schema, the window maths and the message rendering, shared by the
 * daemon, the CLI and the tray. Imports only zod: config.ts imports this file, and
 * policy.ts imports config.ts, so anything more would make a cycle.
 */

export const AWAY_DEFAULT_MESSAGE =
  "{name} is off the grid for the night and will get back to you tomorrow. If something's on fire, call them 🔥"
export const AWAY_MESSAGE_MAX = 1000
/** Only messages at most this old get a reply. */
export const AWAY_MAX_AGE_MS = 600_000
/**
 * At most this many away replies in one away window, whoever writes. A wave of DMs from strangers
 * would otherwise get a reply each from your own account, the pattern Telegram's anti-spam flags.
 */
export const AWAY_MAX_PER_WINDOW = 20

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const timeField = (name: string, fallback: string) =>
  z.string({ error: `${name} must be a time like 18:00` }).regex(TIME_RE, `${name} must be a time like 18:00`).default(fallback)

const QUIET_MSG = 'quietMinutes must be a whole number from 0 to 1440'

export const AwaySchema = z
  .looseObject({
    enabled: z.boolean({ error: 'enabled must be true or false' }).default(false),
    from: timeField('from', '18:00'),
    until: timeField('until', '09:00'),
    message: z
      .string({ error: "The message can't be empty." })
      .refine(m => m.trim() !== '', "The message can't be empty.")
      .refine(m => m.length <= AWAY_MESSAGE_MAX, `The message is too long (${AWAY_MESSAGE_MAX} characters at most).`)
      .default(AWAY_DEFAULT_MESSAGE),
    /** Minutes after anything sent from your account in a chat (you or Claude; not the Page button) before an away reply is allowed; 0 turns that off. */
    quietMinutes: z.number({ error: QUIET_MSG }).int(QUIET_MSG).min(0, QUIET_MSG).max(1440, QUIET_MSG).default(30),
  })
  .refine(a => a.from !== a.until, { message: "From and until can't be the same time." })
export type AwayConfig = z.infer<typeof AwaySchema>

export type AwayPatch = Partial<Pick<AwayConfig, 'enabled' | 'from' | 'until' | 'message' | 'quietMinutes'>>
const PATCH_KEYS = ['enabled', 'from', 'until', 'message', 'quietMinutes']

export function applyAwayPatch(
  current: AwayConfig,
  patch: unknown,
): { ok: true; away: AwayConfig } | { ok: false; error: string } {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch) || Object.keys(patch).length === 0) {
    return { ok: false, error: 'nothing to change: send enabled, from, until, message or quietMinutes' }
  }
  const unknown = Object.keys(patch).filter(k => !PATCH_KEYS.includes(k))
  if (unknown.length > 0) return { ok: false, error: `unknown setting: ${unknown.join(', ')}` }
  const parsed = AwaySchema.safeParse({ ...current, ...patch })
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid away settings' }
  return { ok: true, away: parsed.data }
}

// ---- the window ----------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0')

/** Local date at "HH:MM" on the day `offset` days from `base`'s day. Local constructors keep DST right. */
function localAt(base: Date, offset: number, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number) as [number, number]
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, h, m)
}

/** The away window containing `now` (start included, end excluded), or null. */
export function awayWindowAt(
  away: Pick<AwayConfig, 'from' | 'until'>,
  now: Date,
): { id: string; start: Date; end: Date } | null {
  const crosses = away.from > away.until
  for (const offset of [0, -1]) {
    const start = localAt(now, offset, away.from)
    const end = localAt(now, offset + (crosses ? 1 : 0), away.until)
    if (start <= now && now < end) {
      const id = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}T${pad(start.getHours())}:${pad(start.getMinutes())}`
      return { id, start, end }
    }
  }
  return null
}

/** When away turns on or off next: null if disabled, the window's end if inside one, else the next start. */
export function nextAwayChange(away: AwayConfig, now: Date): Date | null {
  if (!away.enabled) return null
  const w = awayWindowAt(away, now)
  if (w) return w.end
  const today = localAt(now, 0, away.from)
  return today > now ? today : localAt(now, 1, away.from)
}

// ---- the message -----------------------------------------------------------------

export function firstName(me: { name: string } | null | undefined): string | null {
  return me?.name.trim().split(/\s+/)[0] || null
}

/** {name} becomes the first name when there is one. The footer is the caller's job (withFooter in policy.ts). */
export function renderAwayMessage(message: string, name: string | null): string {
  return name === null ? message : message.replaceAll('{name}', name)
}

export function awaySummary(away: AwayConfig, now: Date): string {
  if (!away.enabled) return 'off'
  const hours = `${away.from}–${away.until}`
  return awayWindowAt(away, now)
    ? `on, ${hours} (active now, until ${away.until})`
    : `on, ${hours} (starts at ${away.from})`
}

// ---- CLI ---------------------------------------------------------------------------

const USAGE = 'usage: away [on | off | hours HH:MM HH:MM | message <text> | quiet <minutes>]'

export function parseAwayArgs(
  args: string[],
): { kind: 'show' } | { kind: 'patch'; patch: AwayPatch } | { kind: 'error'; usage: string } {
  const [cmd, ...rest] = args
  if (cmd === undefined) return { kind: 'show' }
  if (cmd === 'on' && rest.length === 0) return { kind: 'patch', patch: { enabled: true } }
  if (cmd === 'off' && rest.length === 0) return { kind: 'patch', patch: { enabled: false } }
  if (cmd === 'hours' && rest.length === 2) return { kind: 'patch', patch: { from: rest[0]!, until: rest[1]! } }
  if (cmd === 'message' && rest.length > 0) return { kind: 'patch', patch: { message: rest.join(' ') } }
  if (cmd === 'quiet' && rest.length === 1 && /^\d+$/.test(rest[0]!)) {
    return { kind: 'patch', patch: { quietMinutes: Number(rest[0]) } }
  }
  return { kind: 'error', usage: USAGE }
}
