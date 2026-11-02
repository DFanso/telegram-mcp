// Builds a release: tgmcp for every platform (`bun build --compile`), the macOS menu bar app,
// one archive per platform, SHA-256 checksums, the two installers and the release notes.
//
//   bun scripts/release.ts [--out dist] [--tag v1.2.3] [--targets aarch64-apple-darwin,...]
//
// Writes <out>/assets/* (everything to attach to the GitHub release) and <out>/notes.md.
// The version is package.json's; --tag (or GITHUB_REF_NAME on a tag build) must match it,
// and CHANGELOG.md must have a "## <version>" section, which becomes "What's new".
// The menu bar app is built only on macOS; elsewhere the macOS archives would lack it, so
// building them there is refused.
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

export interface Target {
  /** Rust-style triple, as kv names its archives. */
  triple: string
  /** bun build --target */
  bun: string
  label: string
  os: 'darwin' | 'linux' | 'windows'
}

export const TARGETS: Target[] = [
  { triple: 'aarch64-apple-darwin', bun: 'bun-darwin-arm64', label: 'Apple Silicon macOS', os: 'darwin' },
  { triple: 'x86_64-apple-darwin', bun: 'bun-darwin-x64', label: 'Intel macOS', os: 'darwin' },
  { triple: 'x86_64-pc-windows-msvc', bun: 'bun-windows-x64', label: 'x64 Windows', os: 'windows' },
  { triple: 'aarch64-unknown-linux-gnu', bun: 'bun-linux-arm64', label: 'ARM64 Linux', os: 'linux' },
  { triple: 'x86_64-unknown-linux-gnu', bun: 'bun-linux-x64', label: 'x64 Linux', os: 'linux' },
]

export const archiveName = (t: Target) => `tgmcp-${t.triple}.${t.os === 'windows' ? 'zip' : 'tar.xz'}`

/** "owner/name" from package.json's repository url. */
export function repoSlug(url: string): string {
  const m = /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?\/?$/.exec(url)
  if (!m) throw new Error(`Can't read a GitHub owner/name from "${url}".`)
  return m[1]!
}

/** The body of CHANGELOG.md's "## <version>" section (up to the next "## "). */
export function changelogSection(changelog: string, version: string): string {
  const lines = changelog.split('\n')
  const head = lines.findIndex(l => new RegExp(`^##\\s+\\[?v?${version.replace(/\./g, '\\.')}\\]?(\\s|$)`).test(l))
  if (head === -1) throw new Error(`CHANGELOG.md has no "## ${version}" section. Add one before releasing.`)
  const next = lines.findIndex((l, i) => i > head && /^##\s/.test(l))
  const body = lines.slice(head + 1, next === -1 ? undefined : next).join('\n').trim()
  if (body === '') throw new Error(`CHANGELOG.md's "## ${version}" section is empty.`)
  return body
}

export function releaseNotes(o: { version: string; repo: string; changes: string; targets?: Target[] }): string {
  const dl = `https://github.com/${o.repo}/releases/download/v${o.version}`
  const rows = (o.targets ?? TARGETS).map(t => `| [${archiveName(t)}](${dl}/${archiveName(t)}) | ${t.label} | [checksum](${dl}/${archiveName(t)}.sha256) |`)
  return `## What's new in ${o.version}

${o.changes}

## Install tgmcp ${o.version}

### Install prebuilt binaries via shell script (macOS, Linux)

\`\`\`sh
curl --proto '=https' --tlsv1.2 -LsSf ${dl}/tgmcp-installer.sh | sh
\`\`\`

### Install prebuilt binaries via powershell script (Windows)

\`\`\`sh
powershell -ExecutionPolicy Bypass -c "irm ${dl}/tgmcp-installer.ps1 | iex"
\`\`\`

The macOS archives include the menu bar app; the shell installer puts it in \`~/Applications\`.

## Download tgmcp ${o.version}

|  File  | Platform | Checksum |
|--------|----------|----------|
${rows.join('\n')}
`
}

export function fillInstaller(template: string, version: string, repo: string): string {
  return template.replaceAll('__VERSION__', version).replaceAll('__REPO__', repo)
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout ?? ''}${r.stderr ?? ''}`)
  return r.stdout.trim()
}

function sha256(path: string): string {
  return new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex')
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function main() {
  const root = resolve(import.meta.dir, '..')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string; repository: { url: string } }
  const version = pkg.version
  const repo = process.env.GITHUB_REPOSITORY ?? repoSlug(pkg.repository.url)
  const tag = arg('tag') ?? (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined)
  if (tag && tag !== `v${version}`) throw new Error(`Tag ${tag} doesn't match package.json's version ${version} (expected v${version}).`)
  const changes = changelogSection(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version)

  const wanted = arg('targets')?.split(',')
  const targets = wanted ? TARGETS.filter(t => wanted.includes(t.triple)) : TARGETS
  if (wanted && targets.length !== wanted.length) throw new Error(`Unknown target in ${wanted.join(',')}.`)
  const onMac = process.platform === 'darwin'
  if (!onMac && targets.some(t => t.os === 'darwin')) throw new Error('macOS archives include the menu bar app, which only builds on macOS.')

  const out = resolve(arg('out') ?? join(root, 'dist'))
  const work = join(out, 'work')
  const assets = join(out, 'assets')
  rmSync(out, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  mkdirSync(assets, { recursive: true })

  let app: string | undefined
  if (targets.some(t => t.os === 'darwin')) {
    console.log('menu bar app (universal)')
    app = run(join(root, 'menubar', 'build.sh'), [], { env: { ARCHS: 'arm64 x86_64', OUT: join(work, 'app'), VERSION: version } }).split('\n').at(-1)!
  }

  for (const t of targets) {
    console.log(`tgmcp ${version} for ${t.triple}`)
    const dir = join(work, `tgmcp-${t.triple}`)
    mkdirSync(dir, { recursive: true })
    const exe = join(dir, t.os === 'windows' ? 'tgmcp.exe' : 'tgmcp')
    run('bun', ['build', join(root, 'src', 'cli.ts'), '--compile', `--target=${t.bun}`, '--outfile', exe], { cwd: root })
    if (t.os === 'darwin' && onMac) run('codesign', ['--force', '--sign', '-', exe])
    copyFileSync(join(root, 'README.md'), join(dir, 'README.md'))
    copyFileSync(join(root, 'LICENSE'), join(dir, 'LICENSE'))
    copyFileSync(join(root, 'CHANGELOG.md'), join(dir, 'CHANGELOG.md'))
    if (t.os === 'darwin') cpSync(app!, join(dir, basename(app!)), { recursive: true, verbatimSymlinks: true })
    const archive = join(assets, archiveName(t))
    if (t.os === 'windows') run('zip', ['-qr', archive, basename(dir)], { cwd: work })
    else run('tar', ['-cJf', archive, basename(dir)], { cwd: work, env: { COPYFILE_DISABLE: '1' } })
  }

  writeFileSync(join(assets, 'tgmcp-installer.sh'), fillInstaller(readFileSync(join(root, 'scripts', 'install.sh'), 'utf8'), version, repo), { mode: 0o755 })
  writeFileSync(join(assets, 'tgmcp-installer.ps1'), fillInstaller(readFileSync(join(root, 'scripts', 'install.ps1'), 'utf8'), version, repo))

  const files = [...targets.map(archiveName), 'tgmcp-installer.sh', 'tgmcp-installer.ps1']
  const sums = files.map(f => `${sha256(join(assets, f))}  ${f}`)
  for (const [i, f] of files.entries()) writeFileSync(join(assets, `${f}.sha256`), `${sums[i]}\n`)
  writeFileSync(join(assets, 'sha256.sum'), `${sums.join('\n')}\n`)

  writeFileSync(join(out, 'notes.md'), releaseNotes({ version, repo, changes, targets }))
  rmSync(work, { recursive: true, force: true })
  console.log(`\n${assets}\n${run('ls', ['-lh', assets])}`)
}

if (import.meta.main) {
  main().catch(e => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
