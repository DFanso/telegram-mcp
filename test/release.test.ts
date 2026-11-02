import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPlist, findMenubarApp } from '../src/launchd'
import { getPaths } from '../src/shared/paths'
import { VERSION, isCompiled, repoRoot, selfCommand, shellJoin } from '../src/shared/runtime'
import { TARGETS, archiveName, changelogSection, fillInstaller, releaseNotes, repoSlug } from '../scripts/release'

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

describe('runtime', () => {
  test('the version is package.json\'s', () => {
    expect(VERSION).toBe(pkg.version)
  })

  test('release binaries are told apart from a checkout by where their code lives', () => {
    expect(isCompiled('/$bunfs/root/tgmcp')).toBe(true)
    expect(isCompiled('B:\\~BUN\\root\\tgmcp.exe')).toBe(true)
    expect(isCompiled('B:/~BUN/root/tgmcp.exe')).toBe(true)
    expect(isCompiled(join(repoRoot, 'src', 'cli.ts'))).toBe(false)
    expect(isCompiled()).toBe(false)
  })

  test('selfCommand: the binary alone, or bun with src/cli.ts', () => {
    expect(selfCommand(true)).toEqual([process.execPath])
    expect(selfCommand(false)).toEqual([process.execPath, join(repoRoot, 'src', 'cli.ts')])
  })

  test('shellJoin quotes only what needs it', () => {
    expect(shellJoin(['/usr/local/bin/tgmcp', 'mcp'])).toBe('/usr/local/bin/tgmcp mcp')
    expect(shellJoin(['/Users/a b/tgmcp', "it's"])).toBe(`'/Users/a b/tgmcp' 'it'\\''s'`)
  })
})

describe('launchd from a release', () => {
  const paths = getPaths('/tmp/tgmcp-home')

  test('a release binary runs itself, from the home folder', () => {
    const plist = buildPlist(paths, true)
    expect(plist).toContain(`<string>${process.execPath}</string>\n      <string>daemon</string>`)
    expect(plist).not.toContain('cli.ts')
    expect(plist).toContain('<key>WorkingDirectory</key><string>/tmp/tgmcp-home</string>')
  })

  test('a checkout runs bun with src/cli.ts, from the checkout', () => {
    const plist = buildPlist(paths, false)
    expect(plist).toContain(`<string>${join(repoRoot, 'src', 'cli.ts')}</string>\n      <string>daemon</string>`)
    expect(plist).toContain(`<key>WorkingDirectory</key><string>${repoRoot}</string>`)
  })

  test('the installed menu bar app is the first candidate that has the executable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgmcp-app-'))
    const empty = join(dir, 'empty', 'Telegram MCP.app')
    const real = join(dir, 'Applications', 'Telegram MCP.app')
    mkdirSync(empty, { recursive: true })
    mkdirSync(join(real, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(join(real, 'Contents', 'MacOS', 'TelegramMCPBar'), '')
    expect(findMenubarApp([undefined, empty, real])).toBe(real)
    expect(() => findMenubarApp([empty])).toThrow('Couldn\'t find "Telegram MCP.app"')
  })
})

describe('release script', () => {
  const changelog = `# Changelog\n\n## 1.1.0\n\n- **New thing** (#4).\n\n## 1.0.0\n\nFirst.\n- one\n`

  test('the changelog section for a version, up to the next one', () => {
    expect(changelogSection(changelog, '1.1.0')).toBe('- **New thing** (#4).')
    expect(changelogSection(changelog, '1.0.0')).toBe('First.\n- one')
    expect(() => changelogSection(changelog, '1.0')).toThrow('no "## 1.0" section')
    expect(() => changelogSection('## 2.0.0\n\n## 1.0.0\nx', '2.0.0')).toThrow('is empty')
  })

  test('the real CHANGELOG.md has a section for package.json\'s version', () => {
    expect(changelogSection(readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8'), pkg.version).length).toBeGreaterThan(0)
  })

  test('repo slug from package.json', () => {
    expect(repoSlug('https://github.com/iddhi-sulakshana/telegram-mcp.git')).toBe('iddhi-sulakshana/telegram-mcp')
    expect(repoSlug('git@github.com:owner/repo.git')).toBe('owner/repo')
    expect(repoSlug(pkg.repository.url)).toBe('iddhi-sulakshana/telegram-mcp')
  })

  test('notes: what\'s new, both installers for this version, and every download with its checksum', () => {
    const notes = releaseNotes({ version: '1.2.3', repo: 'o/r', changes: '- a change' })
    const dl = 'https://github.com/o/r/releases/download/v1.2.3'
    expect(notes).toStartWith("## What's new in 1.2.3\n\n- a change\n")
    expect(notes).toContain(`curl --proto '=https' --tlsv1.2 -LsSf ${dl}/tgmcp-installer.sh | sh`)
    expect(notes).toContain(`irm ${dl}/tgmcp-installer.ps1 | iex`)
    expect(notes).toContain('The Windows zip includes the tray app')
    for (const t of TARGETS) {
      expect(notes).toContain(`| [${archiveName(t)}](${dl}/${archiveName(t)}) | ${t.label} | [checksum](${dl}/${archiveName(t)}.sha256) |`)
    }
  })

  test('archive names follow kv: tar.xz, and zip for Windows', () => {
    expect(TARGETS.map(archiveName)).toEqual([
      'tgmcp-aarch64-apple-darwin.tar.xz',
      'tgmcp-x86_64-apple-darwin.tar.xz',
      'tgmcp-x86_64-pc-windows-msvc.zip',
      'tgmcp-aarch64-unknown-linux-gnu.tar.xz',
      'tgmcp-x86_64-unknown-linux-gnu.tar.xz',
    ])
  })

  test('the installers get the version and repo, and nothing is left unfilled', () => {
    for (const f of ['install.sh', 'install.ps1']) {
      const out = fillInstaller(readFileSync(join(repoRoot, 'scripts', f), 'utf8'), '1.2.3', 'o/r')
      expect(out).not.toContain('__')
      expect(out).toContain('1.2.3')
      expect(out).toContain('https://github.com/o/r/releases/download/v1.2.3/tgmcp-installer')
    }
  })

  test('the PowerShell installer puts the tray app next to tgmcp.exe', () => {
    const ps1 = readFileSync(join(repoRoot, 'scripts', 'install.ps1'), 'utf8')
    expect(ps1).toContain("Install-Exe 'tgmcp.exe'")
    expect(ps1).toContain("Install-Exe 'TelegramMCPTray.exe'")
  })
})
