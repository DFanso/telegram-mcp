import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Paths } from './shared/paths'
import { isCompiled, repoRoot } from './shared/runtime'

/**
 * The Windows tray app (tray/App, C#/WPF): the menu bar app's counterpart. `tgmcp menubar` on
 * Windows starts it at login through a value under HKCU\...\Run, which the app writes itself
 * (`--install`), so the quoting is Windows' own.
 *
 * From a checkout, `tgmcp menubar` builds it with the .NET SDK into tray/build. A release has no
 * tray/ source and needs no .NET: its zip carries a prebuilt, self-contained TelegramMCPTray.exe,
 * which the installer puts next to tgmcp.exe, and `tgmcp menubar` uses that one (findTrayApp).
 */
export const TRAY_EXE = 'TelegramMCPTray.exe'
export const trayBuildDir = join(repoRoot, 'tray', 'build')
const builtTrayExe = join(trayBuildDir, TRAY_EXE)
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
/** Also in tray/App/Instance.cs. */
const RUN_VALUE = 'TelegramMCPTray'

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return {
    ok: r.status === 0,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(),
    missing: (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT',
  }
}

/**
 * The tray app a release installed: TELEGRAM_MCP_TRAY_APP if set, else TelegramMCPTray.exe next to
 * tgmcp.exe (where the release zip and tgmcp-installer.ps1 put it).
 */
export function findTrayApp(
  candidates: (string | undefined)[] = [process.env.TELEGRAM_MCP_TRAY_APP, join(dirname(process.execPath), TRAY_EXE)],
): string {
  const exe = candidates.find(p => p && existsSync(p))
  if (!exe) {
    throw new Error(
      `Couldn't find ${TRAY_EXE} next to tgmcp.exe (in ${dirname(process.execPath)}). Run tgmcp-installer.ps1 again, or set TELEGRAM_MCP_TRAY_APP to its path.`,
    )
  }
  return exe
}

/** The tray app this tgmcp would run, if there is one yet: a release's prebuilt one, or tray/build's. */
function currentTrayApp(compiled: boolean): string | undefined {
  if (!compiled) return existsSync(builtTrayExe) ? builtTrayExe : undefined
  try {
    return findTrayApp()
  } catch {
    return undefined
  }
}

/**
 * Asks a running tray app to quit (it waits up to 5 s): before tray/build's exe is replaced, and
 * so a fresh start picks up the current settings. Any copy of the app can send it.
 */
function quitRunning(compiled: boolean) {
  const exe = currentTrayApp(compiled)
  if (exe) run(exe, ['--quit'])
}

/** Builds tray/App into tray/build with the .NET SDK (from a checkout only). */
export function buildTray(compiled = isCompiled()): string {
  if (compiled) {
    throw new Error(`A release doesn't build the tray app: it comes prebuilt as ${TRAY_EXE} next to tgmcp.exe, and \`tgmcp menubar\` starts it.`)
  }
  quitRunning(false)
  const rid = process.arch === 'arm64' ? 'win-arm64' : 'win-x64'
  const project = join(repoRoot, 'tray', 'App', 'TelegramMCPTray.csproj')
  const r = run('dotnet', ['publish', project, '-c', 'Release', '-r', rid, '--self-contained', 'false', '-o', trayBuildDir, '-nologo', '-v', 'quiet'])
  if (r.missing) throw new Error('The tray app is built with the .NET SDK 10 or later, which is not installed: https://dotnet.microsoft.com/download')
  if (!r.ok) throw new Error(`tray app build failed:\n${r.out}`)
  return builtTrayExe
}

/** The tray app `tgmcp menubar` starts: a release's prebuilt one (never built), or a fresh build. */
export function trayAppFor(compiled = isCompiled()): string {
  if (!compiled) return buildTray(false)
  const exe = findTrayApp()
  quitRunning(true)
  return exe
}

/** The settings the daemon runs with, as arguments: the Run key can't set environment variables. */
function trayArgs(paths: Paths): string[] {
  const args = ['--home', paths.home]
  if (process.env.TELEGRAM_MCP_PORT) args.push('--port', process.env.TELEGRAM_MCP_PORT)
  if (process.env.TELEGRAM_MCP_SECRET_STORE) args.push('--secret-store', process.env.TELEGRAM_MCP_SECRET_STORE)
  return args
}

/** Finds (a release) or builds (a checkout) the tray app, sets it to start at login, and starts it now. */
export function installTray(paths: Paths): string {
  const exe = trayAppFor()
  const args = trayArgs(paths)
  const r = run(exe, ['--install', ...args])
  if (!r.ok) throw new Error(`Could not set the tray app to start at login: ${r.out}`)
  spawn(exe, args, { detached: true, stdio: 'ignore' }).unref()
  return exe
}

/** Stops it starting at login and quits it. False if it wasn't set to start at login. */
export function uninstallTray(): boolean {
  const had = run('reg', ['query', RUN_KEY, '/v', RUN_VALUE]).ok
  const exe = currentTrayApp(isCompiled())
  if (exe) run(exe, ['--uninstall'])
  else if (had) run('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'])
  return had
}
