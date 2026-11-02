#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { ensureHome } from './shared/files'
import { getPaths, getPort } from './shared/paths'
import { FileSecretStore, loadCredentials, openSecretStore, readToken, saveCredentials } from './shared/secrets'
import { ConfigStore } from './shared/config'

const HELP = `tgmcp: always-on Telegram daemon + per-session MCP bridge

  tgmcp install       install/refresh the launchd agent (starts now and at every login, restarts on exit)
  tgmcp uninstall     remove the launchd agent
  tgmcp restart       restart the daemon
  tgmcp status        daemon, Telegram and session status
  tgmcp login         log in to Telegram (interactive; run it in a terminal)
  tgmcp login --credentials   enter api_id/api_hash again, then log in
  tgmcp logs          follow the daemon log
  tgmcp config        print the rules file path
  tgmcp menubar       build and start the menu bar app (approvals, listeners, recent sends) at login
  tgmcp menubar uninstall
  tgmcp call <tool> [json]   call a tool as a one-off session, e.g. tgmcp call telegram_get_rules
  tgmcp mcp-add       print the command that registers the MCP server with Claude Code
  tgmcp daemon        run the daemon in the foreground
  tgmcp mcp [--channel]  stdio MCP server (Claude Code starts this, one per session)

Files live in ${getPaths().home} (override with TELEGRAM_MCP_HOME). Port ${getPort()} (TELEGRAM_MCP_PORT).
Secrets (login key, API token, api_hash) live in the OS keystore; TELEGRAM_MCP_SECRET_STORE=file keeps them in files.`

async function daemonFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await readToken(openSecretStore(getPaths()))
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
    secrets?: { kind: string; where: string }
    menubar: boolean
    sessions: { id: string; label: string; connected: boolean; channel: boolean; monitors: number; watches: number; pending: number }[]
  }
  const paths = getPaths()
  try {
    const secrets = openSecretStore(paths)
    console.log(`secrets: ${secrets.where}`)
    const left = new FileSecretStore(paths).present()
    if (secrets.kind === 'keychain' && left.length > 0) {
      console.log(`  plain-text copies still on disk: ${left.join(', ')} (moved into the keystore the next time the daemon, a proxy or the CLI reads them)`)
    }
  } catch (e) {
    console.log(`secrets: ${e instanceof Error ? e.message : e}`)
    process.exitCode = 1
    return
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
  if (body.secrets && body.secrets.kind !== openSecretStore(paths).kind) {
    console.log(`  the daemon keeps its secrets in ${body.secrets.where}: restart it (tgmcp install) so both agree`)
  }
  console.log(`menu bar app: ${body.menubar ? 'connected (approvals go there)' : 'not running (approvals use the Claude Code dialog)'}`)
  console.log(`sessions: ${body.sessions.length}`)
  for (const s of body.sessions) {
    console.log(
      `  ${s.id} ${s.label} · ${s.connected ? 'connected' : 'gone (grace period)'}${s.channel ? ' · channel' : ''} · ${s.watches} watches · ${s.monitors} monitors · ${s.pending} queued`,
    )
  }
}

async function login(askCredentials: boolean) {
  const paths = getPaths()
  ensureHome(paths)
  const secrets = openSecretStore(paths)
  // Never run a second client next to a connected daemon: two connections on one auth key at
  // once can get the session killed by Telegram.
  let connectedAs: string | null = null
  try {
    const res = await daemonFetch('/status')
    const body = (await res.json()) as { telegram: { phase: string; me: { name: string } | null } }
    if (body.telegram.phase === 'connected') connectedAs = body.telegram.me?.name ?? 'your account'
  } catch {}
  if (connectedAs && !askCredentials) {
    console.log(`Already logged in as ${connectedAs}. Nothing to do.`)
    return
  }

  let creds = askCredentials ? null : await loadCredentials(secrets)
  if (!creds) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    console.log('Telegram API credentials (from https://my.telegram.org → API development tools).')
    const apiId = Number((await rl.question('api_id: ')).trim())
    const apiHash = (await rl.question('api_hash: ')).trim()
    rl.close()
    if (!apiId || !apiHash) throw new Error('Both api_id and api_hash are needed.')
    creds = { apiId, apiHash }
    await saveCredentials(secrets, creds)
    console.log(`Saved to ${secrets.where}`)
  }
  if (connectedAs) {
    console.log(`The daemon is logged in as ${connectedAs}. Run \`tgmcp restart\` to use the new credentials.`)
    return
  }

  const { TelegramClient } = await import('@mtcute/bun')
  const { openSessionStorage } = await import('./daemon/session-store')
  // fresh: a session.db whose key is gone can't be used, so start over instead of failing.
  const storage = await openSessionStorage(paths.session, secrets, { fresh: true, log: m => console.log(m) })
  const tg = new TelegramClient({ apiId: creds.apiId, apiHash: creds.apiHash, storage, updates: false })
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
// Everything we create in the home folder is private to you.
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
    await login(rest.includes('--credentials'))
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
    const secrets = openSecretStore(getPaths())
    const client = new DaemonClient({
      url: async () => {
        const token = await readToken(secrets)
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
