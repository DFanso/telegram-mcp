import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Paths } from './shared/paths'

/**
 * The Windows tray app (tray/App, C#/WPF): the menu bar app's counterpart. `tgmcp menubar` on
 * Windows builds it with the .NET SDK into tray/build and starts it at login through a value under
 * HKCU\...\Run, which the app writes itself (`--install`), so the quoting is Windows' own.
 */
const repoRoot = resolve(import.meta.dir, '..')
export const trayBuildDir = join(repoRoot, 'tray', 'build')
export const trayExe = join(trayBuildDir, 'TelegramMCPTray.exe')
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

/** A running exe can't be replaced: ask the running tray app to quit first (it waits up to 5 s). */
function quitRunning() {
  if (existsSync(trayExe)) run(trayExe, ['--quit'])
}

export function buildTray(): string {
  quitRunning()
  const rid = process.arch === 'arm64' ? 'win-arm64' : 'win-x64'
  const project = join(repoRoot, 'tray', 'App', 'TelegramMCPTray.csproj')
  const r = run('dotnet', ['publish', project, '-c', 'Release', '-r', rid, '--self-contained', 'false', '-o', trayBuildDir, '-nologo', '-v', 'quiet'])
  if (r.missing) throw new Error('The tray app is built with the .NET SDK 10 or later, which is not installed: https://dotnet.microsoft.com/download')
  if (!r.ok) throw new Error(`tray app build failed:\n${r.out}`)
  return trayExe
}

/** The settings the daemon runs with, as arguments: the Run key can't set environment variables. */
function trayArgs(paths: Paths): string[] {
  const args = ['--home', paths.home]
  if (process.env.TELEGRAM_MCP_PORT) args.push('--port', process.env.TELEGRAM_MCP_PORT)
  if (process.env.TELEGRAM_MCP_SECRET_STORE) args.push('--secret-store', process.env.TELEGRAM_MCP_SECRET_STORE)
  return args
}

/** Builds it, sets it to start at login, and starts it now. */
export function installTray(paths: Paths): string {
  const exe = buildTray()
  const args = trayArgs(paths)
  const r = run(exe, ['--install', ...args])
  if (!r.ok) throw new Error(`Could not set the tray app to start at login: ${r.out}`)
  spawn(exe, args, { detached: true, stdio: 'ignore' }).unref()
  return exe
}

/** Stops it starting at login and quits it. False if it wasn't set to start at login. */
export function uninstallTray(): boolean {
  const had = run('reg', ['query', RUN_KEY, '/v', RUN_VALUE]).ok
  if (existsSync(trayExe)) run(trayExe, ['--uninstall'])
  else if (had) run('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'])
  return had
}
