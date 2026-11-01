import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { LAUNCHD_LABEL, type Paths } from './shared/paths'

export const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
const domain = () => `gui/${process.getuid?.() ?? 0}`

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A user LaunchAgent: starts at login, restarts whenever the daemon exits. */
export function buildPlist(paths: Paths): string {
  const cli = resolve(import.meta.dir, 'cli.ts')
  const env: Record<string, string> = {
    PATH: `${dirname(process.execPath)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`,
    TELEGRAM_MCP_HOME: paths.home,
  }
  if (process.env.TELEGRAM_MCP_PORT) env.TELEGRAM_MCP_PORT = process.env.TELEGRAM_MCP_PORT
  const envXml = Object.entries(env)
    .map(([k, v]) => `      <key>${esc(k)}</key><string>${esc(v)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${esc(process.execPath)}</string>
      <string>${esc(cli)}</string>
      <string>daemon</string>
    </array>
    <key>WorkingDirectory</key><string>${esc(resolve(import.meta.dir, '..'))}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>5</integer>
    <key>StandardOutPath</key><string>${esc(join(paths.home, 'daemon.stdout.log'))}</string>
    <key>StandardErrorPath</key><string>${esc(join(paths.home, 'daemon.stderr.log'))}</string>
  </dict>
</plist>
`
}

function launchctl(...args: string[]) {
  const r = spawnSync('launchctl', args, { encoding: 'utf8' })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

export function installAgent(paths: Paths): string {
  mkdirSync(dirname(plistPath), { recursive: true })
  mkdirSync(paths.home, { recursive: true, mode: 0o700 })
  writeFileSync(plistPath, buildPlist(paths))
  launchctl('bootout', `${domain()}/${LAUNCHD_LABEL}`)
  const r = launchctl('bootstrap', domain(), plistPath)
  if (!r.ok) throw new Error(`launchctl bootstrap failed: ${r.out}`)
  return plistPath
}

export function uninstallAgent(): boolean {
  const had = existsSync(plistPath)
  launchctl('bootout', `${domain()}/${LAUNCHD_LABEL}`)
  rmSync(plistPath, { force: true })
  return had
}

export function restartAgent(): void {
  const r = launchctl('kickstart', '-k', `${domain()}/${LAUNCHD_LABEL}`)
  if (!r.ok) throw new Error(`launchctl kickstart failed (is it installed? run \`tgmcp install\`): ${r.out}`)
}

export function agentInfo(): string | null {
  const r = launchctl('print', `${domain()}/${LAUNCHD_LABEL}`)
  if (!r.ok) return null
  const state = /\n\s*state = (.+)/.exec(r.out)?.[1]
  const pid = /\n\s*pid = (\d+)/.exec(r.out)?.[1]
  const runs = /\n\s*runs = (\d+)/.exec(r.out)?.[1]
  return [state && `state ${state}`, pid && `pid ${pid}`, runs && `${runs} runs`].filter(Boolean).join(', ')
}
