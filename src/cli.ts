#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { ensureHome, loadCredentials, readToken, saveCredentials } from './shared/files'
import { getPaths, getPort } from './shared/paths'
import { ConfigStore } from './shared/config'

const HELP = `tgmcp: always-on Telegram daemon + per-session MCP bridge

  tgmcp install       install/refresh the launchd agent (starts now and at every login, restarts on exit)
  tgmcp uninstall     remove the launchd agent
  tgmcp restart       restart the daemon
  tgmcp status        daemon, Telegram and session status
  tgmcp login         log in to Telegram (interactive; run it in a terminal)
  tgmcp logs          follow the daemon log
  tgmcp config        print the rules file path
  tgmcp menubar       build and start the menu bar app (approvals, listeners, recent sends) at login
  tgmcp menubar uninstall
  tgmcp call <tool> [json]   call a tool as a one-off session, e.g. tgmcp call telegram_get_rules
  tgmcp mcp-add       print the command that registers the MCP server with Claude Code
  tgmcp daemon        run the daemon in the foreground
  tgmcp mcp [--channel]  stdio MCP server (Claude Code starts this, one per session)

Files live in ${getPaths().home} (override with TELEGRAM_MCP_HOME). Port ${getPort()} (TELEGRAM_MCP_PORT).`

async function daemonFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = readToken(getPaths())
  return fetch(`http://127.0.0.1:${getPort()}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token ?? ''}` },
    signal: AbortSignal.timeout(3_000),
  })
}

async function status() {
  const { agentInfo } = await import('./launchd')
  const agent = agentInfo()
  console.log(`launchd agent: ${agent ?? 'not installed'}`)
  let body: {
    pid: number
    startedAt: string
    telegram: { phase: string; me: { name: string; username: string | null; id: number } | null; reconnects: number; lastError: string | null; since: number }
    config: { path: string; error: string | null }
    menubar: boolean
    sessions: { id: string; label: string; connected: boolean; channel: boolean; monitors: number; watches: number; pending: number }[]
  }
  try {
    const res = await daemonFetch('/status')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    body = (await res.json()) as typeof body
  } catch (e) {
    console.log(`daemon: not reachable on 127.0.0.1:${getPort()} (${e instanceof Error ? e.message : e})`)
    process.exitCode = 1
    return
  }
  const t = body.telegram
  console.log(`daemon: pid ${body.pid}, up since ${body.startedAt}`)
  console.log(
    `telegram: ${t.phase}${t.me ? ` as ${t.me.name}${t.me.username ? ` (@${t.me.username})` : ''}` : ''}, ${t.reconnects} reconnects${t.lastError && t.phase !== 'connected' ? `\n  last error: ${t.lastError}` : ''}`,
  )
  console.log(`config: ${body.config.path}${body.config.error ? `\n  ${body.config.error}` : ''}`)
  console.log(`menu bar app: ${body.menubar ? 'connected (approvals go there)' : 'not running (approvals use the Claude Code dialog)'}`)
  console.log(`sessions: ${body.sessions.length}`)
  for (const s of body.sessions) {
    console.log(
      `  ${s.id} ${s.label} · ${s.connected ? 'connected' : 'gone (grace period)'}${s.channel ? ' · channel' : ''} · ${s.watches} watches · ${s.monitors} monitors · ${s.pending} queued`,
    )
  }
}

async function login() {
  const paths = getPaths()
  ensureHome(paths)
  try {
    const res = await daemonFetch('/status')
    const body = (await res.json()) as { telegram: { phase: string; me: { name: string } | null } }
    if (body.telegram.phase === 'connected') {
      console.log(`Already logged in as ${body.telegram.me?.name}. Nothing to do.`)
      return
    }
  } catch {}

  let creds = loadCredentials(paths)
  if (!creds) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    console.log('Telegram API credentials (from https://my.telegram.org → API development tools).')
    const apiId = Number((await rl.question('api_id: ')).trim())
    const apiHash = (await rl.question('api_hash: ')).trim()
    rl.close()
    if (!apiId || !apiHash) throw new Error('Both api_id and api_hash are needed.')
    creds = { apiId, apiHash }
    saveCredentials(paths, creds)
    console.log(`Saved to ${paths.credentials}`)
  }

  const { TelegramClient } = await import('@mtcute/bun')
  const tg = new TelegramClient({ apiId: creds.apiId, apiHash: creds.apiHash, storage: paths.session, updates: false })
  const me = await tg.start({
    phone: () => tg.input('Phone number (international format, e.g. +94771234567): '),
    code: () => tg.input('Login code (sent to your Telegram app): '),
    password: () => tg.input('Two-step verification password: '),
  })
  console.log(`Logged in as ${me.displayName}${me.username ? ` (@${me.username})` : ''}.`)
  await tg.destroy()
  ensureHome(paths) // tighten the new session files to 0600

  try {
    await daemonFetch('/admin/reconnect', { method: 'POST' })
    console.log('Told the daemon to connect. Check with `tgmcp status`.')
  } catch {
    console.log('The daemon is not running. Start it with `tgmcp install`.')
  }
}

function mcpAdd() {
  const cli = resolve(import.meta.dir, 'cli.ts')
  console.log('Register for every project (user scope):\n')
  console.log(`  claude mcp add --scope user tg -- ${process.execPath} ${cli} mcp\n`)
  console.log('Optional push mode (messages appear in the session by themselves; needs the dev-channels flag at launch):\n')
  console.log(`  claude mcp add --scope user tg -- ${process.execPath} ${cli} mcp --channel`)
  console.log('  claude --dangerously-load-development-channels server:tg')
}

const [cmd, ...rest] = process.argv.slice(2)
// The session file is a login for your account: everything we create is private to you.
process.umask(0o077)
switch (cmd) {
  case 'daemon': {
    const { runDaemon } = await import('./daemon/main')
    await runDaemon()
    break
  }
  case 'mcp': {
    const { runProxy } = await import('./mcp/proxy')
    await runProxy({ channel: rest.includes('--channel') || process.env.TELEGRAM_MCP_CHANNEL === '1' })
    break
  }
  case 'install': {
    const { installAgent } = await import('./launchd')
    const paths = getPaths()
    ensureHome(paths)
    new ConfigStore(paths.config).close()
    console.log(`Installed ${installAgent(paths)}. The daemon is starting; check with \`tgmcp status\`.`)
    break
  }
  case 'uninstall': {
    const { uninstallAgent } = await import('./launchd')
    console.log(uninstallAgent() ? 'Removed the launchd agent and stopped the daemon.' : 'No launchd agent was installed.')
    break
  }
  case 'restart': {
    const { restartAgent } = await import('./launchd')
    restartAgent()
    console.log('Restarted.')
    break
  }
  case 'status':
    await status()
    break
  case 'login':
    await login()
    break
  case 'logs': {
    const p = getPaths()
    spawn('tail', ['-n', '50', '-F', p.log, `${p.home}/daemon.stderr.log`], { stdio: 'inherit' })
    break
  }
  case 'config':
    console.log(getPaths().config)
    break
  case 'call': {
    // Call a tool as a throwaway session: tgmcp call telegram_status '{}'
    const [tool, json] = rest
    if (!tool) {
      console.log('usage: tgmcp call <tool> [json-args]')
      process.exit(1)
    }
    const { DaemonClient } = await import('./mcp/daemon-client')
    const { newId } = await import('./daemon/sessions')
    const paths = getPaths()
    const client = new DaemonClient({
      url: () => {
        const token = readToken(paths)
        return token ? `ws://127.0.0.1:${getPort()}/bridge?token=${token}` : null
      },
      sessionId: newId('s_'),
      label: 'tgmcp call',
      channel: false,
      log: () => {},
    })
    client.start()
    try {
      const { result } = await client.call(tool, json ? JSON.parse(json) : {})
      console.log(result.text)
      if (result.isError) process.exitCode = 1
    } catch (e) {
      console.error(e instanceof Error ? e.message : e)
      process.exitCode = 1
    }
    client.close()
    process.exit()
  }
  case 'menubar': {
    const sub = rest[0] ?? 'install'
    const { buildMenubar, installMenubar, uninstallMenubar } = await import('./launchd')
    if (sub === 'build') console.log(buildMenubar())
    else if (sub === 'install') console.log(`Menu bar app running and starts at login: ${installMenubar(getPaths())}`)
    else if (sub === 'uninstall') console.log(uninstallMenubar() ? 'Removed the menu bar app agent.' : 'It was not installed.')
    else console.log('usage: tgmcp menubar [install|uninstall|build]')
    break
  }
  case 'mcp-add':
    mcpAdd()
    break
  default:
    console.log(HELP)
    if (cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exitCode = 1
}
