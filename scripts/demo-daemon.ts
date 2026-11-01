// A daemon with a fake Telegram and some state, for working on the menu bar app without a real account.
//   bun scripts/demo-daemon.ts            then, in another shell:
//   TELEGRAM_MCP_HOME=/tmp/tgmcp-demo TELEGRAM_MCP_PORT=47901 "menubar/build/Telegram MCP.app/Contents/MacOS/TelegramMCPBar"
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createDaemon } from '../src/daemon/main'
import { DaemonClient } from '../src/mcp/daemon-client'
import { getPaths } from '../src/shared/paths'
import { ANNA, FakeTelegram, TEAM_QA, LEO, LEONARDO } from '../test/fake-telegram'

const home = '/tmp/tgmcp-demo'
rmSync(home, { recursive: true, force: true })
mkdirSync(home, { recursive: true })
const paths = getPaths(home)
writeFileSync(
  paths.config,
  JSON.stringify({
    footer: '\n\n✨ sᴇɴᴛ ᴠɪᴀ ᴄʟᴀᴜᴅᴇ',
    chats: {
      leo: { id: LEO.id, username: 'leo_p', name: LEO.name },
      anna: { id: ANNA.id, username: 'anna_k', name: ANNA.name },
      'team-qa': { id: TEAM_QA.id, name: 'Team QA', topicId: 42 },
    },
    rules: { autoSend: ['leo', 'anna'], requireApproval: ['team-qa'], autoReply: ['anna', 'leo'] },
  }),
)
const tg = new FakeTelegram().add(LEO, ANNA, TEAM_QA, LEONARDO)
const daemon = await createDaemon({ paths, port: 47901, telegram: tg, log: () => {} })

function session(label: string) {
  const c = new DaemonClient({
    url: () => `ws://127.0.0.1:47901/bridge?token=${daemon.token}`,
    sessionId: `s_${label.padEnd(8, 'x').slice(0, 8)}`,
    label,
    channel: false,
    log: () => {},
  })
  c.start()
  return c
}
const api = session('api-server · pid 4121')
const web = session('web-app · pid 5230')
await api.call('telegram_watch', { chat: 'anna', note: 'waiting for the staging link' })
await web.call('telegram_watch', { chat: 'anna' })
await web.call('telegram_watch', { chat: 'leo' })
await api.call('telegram_send_message', { to: 'leo', text: 'Deployed v2.3 to staging, can you check the login flow?' })
await web.call('telegram_send_message', { to: 'anna', text: 'The signup form now accepts uploads up to 10 MB.' })
await api.call('telegram_send_message', { to: 'leo', text: 'Also the rate limiter is back on.' })
await api.call('telegram_send_message', { to: 'team-qa', text: 'Hi team, v2.3 is on staging. Please run the QA checklist for the upload flow.' })
await web.call('telegram_send_message', { to: '@leonardo_s', text: 'Hey Leonardo, are you free for a quick call about the payments integration?' })
console.log(`demo daemon on 47901, home ${home}`)
