/** Naming and sizes for files moving between Telegram and disk. */

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/x-tgsticker': '.tgs',
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** A sender picks the file name, so keep only a plain base name: no folders, no leading dots. */
export function safeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? ''
  const clean = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\p{L}\p{M}\p{N} ._()+-]/gu, '_')
    .replace(/^[.\s]+/, '')
    .trim()
  if (!clean) return ''
  if (clean.length <= 120) return clean
  const dot = clean.lastIndexOf('.')
  const ext = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : ''
  return clean.slice(0, 120 - ext.length) + ext
}

/** `<message id>-<name>`, so two files called "photo.jpg" in one chat never overwrite each other. */
export function downloadFileName(messageId: number, file: { name: string | null; type: string; mime: string | null }): string {
  const given = file.name ? safeFileName(file.name) : ''
  const name = given || `${file.type}${(file.mime && EXT_BY_MIME[file.mime]) ?? (file.type === 'photo' ? '.jpg' : '')}`
  return `${messageId}-${name}`
}
