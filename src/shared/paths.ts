import { homedir } from 'node:os'
import { join } from 'node:path'

export const LAUNCHD_LABEL = 'com.telegram-mcp.daemon'
export const DEFAULT_PORT = 47823

export interface Paths {
  home: string
  config: string
  credentials: string
  session: string
  token: string
  log: string
}

/** Everything lives in one folder, `~/.config/telegram-mcp` unless TELEGRAM_MCP_HOME says otherwise. */
export function getPaths(home = process.env.TELEGRAM_MCP_HOME ?? join(homedir(), '.config', 'telegram-mcp')): Paths {
  return {
    home,
    config: join(home, 'config.json'),
    credentials: join(home, 'credentials.json'),
    session: join(home, 'session.db'),
    token: join(home, 'token'),
    log: join(home, 'daemon.log'),
  }
}

export function getPort(): number {
  const raw = process.env.TELEGRAM_MCP_PORT
  const port = raw ? Number(raw) : DEFAULT_PORT
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT
}
