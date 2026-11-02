import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { TRAY_EXE, buildTray, findTrayApp, trayAppFor } from '../src/tray'

const saved = process.env.TELEGRAM_MCP_TRAY_APP
afterEach(() => {
  if (saved === undefined) delete process.env.TELEGRAM_MCP_TRAY_APP
  else process.env.TELEGRAM_MCP_TRAY_APP = saved
})

function fakeExe(): string {
  const exe = join(mkdtempSync(join(tmpdir(), 'tgmcp-tray-')), TRAY_EXE)
  writeFileSync(exe, '')
  return exe
}

describe('the tray app in a release', () => {
  test('the first candidate that exists: TELEGRAM_MCP_TRAY_APP, then next to tgmcp.exe', () => {
    const a = fakeExe()
    const b = fakeExe()
    expect(findTrayApp([undefined, join(dirname(a), 'missing.exe'), b, a])).toBe(b)
    process.env.TELEGRAM_MCP_TRAY_APP = a
    expect(findTrayApp()).toBe(a)
  })

  test('by default it looks next to the running binary', () => {
    delete process.env.TELEGRAM_MCP_TRAY_APP
    // bun's folder has no TelegramMCPTray.exe, so the error names where it looked.
    expect(() => findTrayApp()).toThrow(`Couldn't find ${TRAY_EXE} next to tgmcp.exe (in ${dirname(process.execPath)})`)
  })

  test('a missing exe says to run the installer again', () => {
    expect(() => findTrayApp([join(tmpdir(), 'nope', TRAY_EXE)])).toThrow('Run tgmcp-installer.ps1 again')
  })

  test('a release uses the prebuilt exe and never builds one', () => {
    const exe = fakeExe()
    process.env.TELEGRAM_MCP_TRAY_APP = exe
    expect(trayAppFor(true)).toBe(exe)
    expect(() => buildTray(true)).toThrow("A release doesn't build the tray app")
  })
})
