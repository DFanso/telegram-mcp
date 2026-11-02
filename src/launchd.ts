import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { LAUNCHD_LABEL, type Paths } from './shared/paths'
import { isCompiled, repoRoot, selfCommand } from './shared/runtime'

export const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
const domain = () => `gui/${process.getuid?.() ?? 0}`

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Settings the CLI was run with that the daemon and the menu bar app must share. */
function passThrough(env: Record<string, string>) {
  for (const k of ['TELEGRAM_MCP_PORT', 'TELEGRAM_MCP_SECRET_STORE']) {
    const v = process.env[k]
    if (v) env[k] = v
  }
  return env
}

/**
 * A user LaunchAgent: starts at login, restarts whenever the daemon exits. It runs whichever
 * tgmcp ran `tgmcp install`: a release binary, or bun with this checkout's src/cli.ts.
 */
export function buildPlist(paths: Paths, compiled = isCompiled()): string {
  const env = passThrough({
    PATH: `${dirname(process.execPath)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`,
    TELEGRAM_MCP_HOME: paths.home,
  })
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
${[...selfCommand(compiled), 'daemon'].map(a => `      <string>${esc(a)}</string>`).join('\n')}
    </array>
    <key>WorkingDirectory</key><string>${esc(compiled ? paths.home : repoRoot)}</string>
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

/**
 * Unloads the old job, waits until launchd has really let go of it (an app can take a moment
 * to quit), then loads the plist. Loading too early fails with "5: Input/output error".
 */
function reload(label: string, plist: string) {
  launchctl('bootout', `${domain()}/${label}`)
  for (let i = 0; i < 50 && launchctl('print', `${domain()}/${label}`).ok; i++) Bun.sleepSync(100)
  let r = launchctl('bootstrap', domain(), plist)
  for (let i = 0; i < 5 && !r.ok; i++) {
    Bun.sleepSync(500)
    r = launchctl('bootstrap', domain(), plist)
  }
  if (!r.ok) throw new Error(`launchctl bootstrap failed: ${r.out}`)
}

export function installAgent(paths: Paths): string {
  mkdirSync(dirname(plistPath), { recursive: true })
  mkdirSync(paths.home, { recursive: true, mode: 0o700 })
  writeFileSync(plistPath, buildPlist(paths))
  reload(LAUNCHD_LABEL, plistPath)
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

// ---- the menu bar app ------------------------------------------------------------------

export const MENUBAR_LABEL = 'com.telegram-mcp.menubar'
export const menubarPlistPath = join(homedir(), 'Library', 'LaunchAgents', `${MENUBAR_LABEL}.plist`)
const APP_NAME = 'Telegram MCP.app'

/** Builds menubar/ into menubar/build/ (needs a checkout and Xcode's command line tools). */
export function buildMenubar(): string {
  if (isCompiled()) {
    throw new Error('Building the menu bar app needs a checkout of telegram-mcp. A release already includes it: run `tgmcp menubar`.')
  }
  const r = spawnSync(join(repoRoot, 'menubar', 'build.sh'), { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`menu bar build failed:\n${r.stdout}${r.stderr}`)
  return r.stdout.trim().split('\n').at(-1)!
}

/**
 * The menu bar app a release installed: TELEGRAM_MCP_MENUBAR_APP, next to the binary, or in
 * ~/Applications or /Applications (where the release installer puts it).
 */
export function findMenubarApp(candidates = [
  process.env.TELEGRAM_MCP_MENUBAR_APP,
  join(dirname(process.execPath), APP_NAME),
  join(homedir(), 'Applications', APP_NAME),
  join('/Applications', APP_NAME),
]): string {
  const app = candidates.find(p => p && existsSync(join(p, 'Contents', 'MacOS', 'TelegramMCPBar')))
  if (!app) {
    throw new Error(`Couldn't find "${APP_NAME}". The release installer puts it in ~/Applications; run it again, or set TELEGRAM_MCP_MENUBAR_APP to the app's path.`)
  }
  return app
}

/** Starts at login; restarts after a crash but stays quit when you choose Quit. */
export function installMenubar(paths: Paths): string {
  const app = isCompiled() ? findMenubarApp() : buildMenubar()
  const env = passThrough({ TELEGRAM_MCP_HOME: paths.home })
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${MENUBAR_LABEL}</string>
    <key>ProgramArguments</key>
    <array><string>${esc(join(app, 'Contents', 'MacOS', 'TelegramMCPBar'))}</string></array>
    <key>EnvironmentVariables</key>
    <dict>
${Object.entries(env).map(([k, v]) => `      <key>${esc(k)}</key><string>${esc(v)}</string>`).join('\n')}
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
    <key>LimitLoadToSessionType</key><string>Aqua</string>
    <key>ProcessType</key><string>Interactive</string>
  </dict>
</plist>
`
  writeFileSync(menubarPlistPath, plist)
  reload(MENUBAR_LABEL, menubarPlistPath)
  return app
}

export function uninstallMenubar(): boolean {
  const had = existsSync(menubarPlistPath)
  launchctl('bootout', `${domain()}/${MENUBAR_LABEL}`)
  rmSync(menubarPlistPath, { force: true })
  return had
}

export function agentInfo(): string | null {
  const r = launchctl('print', `${domain()}/${LAUNCHD_LABEL}`)
  if (!r.ok) return null
  const state = /\n\s*state = (.+)/.exec(r.out)?.[1]
  const pid = /\n\s*pid = (\d+)/.exec(r.out)?.[1]
  const runs = /\n\s*runs = (\d+)/.exec(r.out)?.[1]
  return [state && `state ${state}`, pid && `pid ${pid}`, runs && `${runs} runs`].filter(Boolean).join(', ')
}
