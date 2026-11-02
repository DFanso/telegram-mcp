import { resolve } from 'node:path'
import pkg from '../../package.json'

/** package.json's version, built into release binaries. */
export const VERSION: string = pkg.version

/**
 * True in a release binary (`bun build --compile`). Its modules live in Bun's embedded file
 * system (`/$bunfs/…`, or `B:\~BUN\…` on Windows), so there is no checkout: no src/cli.ts to
 * point launchd or Claude Code at, and no menubar/ to build the app from.
 */
export function isCompiled(main: string = Bun.main): boolean {
  return main.startsWith('/$bunfs/') || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(main)
}

/** The command that runs this same tgmcp: the release binary itself, or bun with src/cli.ts. */
export function selfCommand(compiled = isCompiled()): string[] {
  return compiled ? [process.execPath] : [process.execPath, resolve(import.meta.dir, '..', 'cli.ts')]
}

/** The checkout this runs from (meaningless in a release binary). */
export const repoRoot = resolve(import.meta.dir, '..', '..')

/** A command line as you'd paste it into a shell: arguments with spaces or quotes get quoted. */
export function shellJoin(args: string[]): string {
  return args.map(a => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ')
}
