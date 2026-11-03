/**
 * A daemon answer the CLI can always print: JSON {ok, text} when the daemon got that far, or
 * whatever came back instead (a plain-text 401 from an old token, a 404 from an older daemon).
 */
export async function readDaemonReply(res: Response): Promise<{ ok: boolean; text: string }> {
  const raw = await res.text()
  try {
    const body = JSON.parse(raw) as { ok?: unknown; text?: unknown }
    if (typeof body.text === 'string') return { ok: res.ok && body.ok === true, text: body.text }
  } catch {}
  const hint =
    res.status === 401 ? ' (the daemon did not accept the token; try tgmcp restart)' : res.status === 404 ? ' (this daemon has no pager yet; tgmcp restart runs the new code)' : ''
  return { ok: false, text: `The daemon answered ${res.status}${hint}: ${raw.trim().slice(0, 200) || '(empty)'}` }
}
