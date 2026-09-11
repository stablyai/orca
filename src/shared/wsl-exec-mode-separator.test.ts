import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Why: `wsl.exe <...> -- <argv>` expands $name in every argument against the guest
// environment before the guest runs, silently rewriting scripts (an `awk '{print $2}'`
// loses its field reference). `--exec` passes argv through untouched. Nothing may
// reintroduce the `--` mode separator, so guard the tree instead of each call site.
//
// Two spellings reach wsl.exe, and both have shipped a regression: an argv array, and
// a command line built as a string (PowerShell setup commands). Comments describing
// the old form are allowed — only code is scanned.
// Guest programs Orca hands to wsl.exe. An allowlist rather than "any quoted
// token", because git's own `--` pathspec separator is followed by one too.
const GUEST_PROGRAM = String.raw`(?:\/[\w./-]+\/)?(?:sh|bash|zsh|dash|ash|ksh|mksh|env|rm|cat|printf|node|python3?)`
// `\s*` has to cross newlines: the formatter puts each argv element on its own
// line, which is the exact shape this guard exists to catch.
const ARGV_FORM = new RegExp(String.raw`'--',\s*'${GUEST_PROGRAM}'`)
const STRING_FORM = new RegExp(String.raw`wsl(?:\.exe)?\b[^\n]*?[^-]--\s+${GUEST_PROGRAM}\b`)

const SCANNED_ROOTS = ['src', 'config', 'tests']
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js']
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'out', 'build', '.git'])
// Why: the cross-version e2e lane checks whole historical releases out under
// tests/e2e/.cross-version-checkouts/. Those are shipped code we cannot edit, so
// scanning them made this guard fail on every machine that had run that lane --
// 21 "offenders", all of them copies of a past release.
const IGNORED_DIRECTORY_PREFIX = '.'

function collectSourceFiles(root: string): string[] {
  let found: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return found
  }
  for (const entry of entries) {
    if (IGNORED_DIRECTORIES.has(entry) || entry.startsWith(IGNORED_DIRECTORY_PREFIX)) {
      continue
    }
    const full = join(root, entry)
    if (statSync(full).isDirectory()) {
      found = found.concat(collectSourceFiles(full))
      continue
    }
    if (SCANNED_EXTENSIONS.some((extension) => full.endsWith(extension))) {
      found.push(full)
    }
  }
  return found
}

/**
 * Drop comment-only lines, then rejoin.
 *
 * Why rejoin: an argv array is formatted one element per line, so matching each
 * line in isolation cannot see `'--',\n  'bash'` — the shape the guard is for.
 */
function codeText(contents: string): string {
  return contents
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')
}

describe('wsl.exe mode separator', () => {
  const repoRoot = resolve(__dirname, '..', '..')
  const files = SCANNED_ROOTS.flatMap((root) => collectSourceFiles(join(repoRoot, root)))

  it('scans a plausible number of files', () => {
    // A broken root or extension list would make the guard silently vacuous.
    expect(files.length).toBeGreaterThan(500)
  })

  it.each([
    ['argv array', ARGV_FORM],
    ['command string', STRING_FORM]
  ])('never hands the guest shell to wsl.exe through `--` (%s)', (_form, pattern) => {
    const offenders = files.filter((file) => {
      const text = codeText(readFileSync(file, 'utf8'))
      // Why scoped to WSL files: other tools take a `--` separator followed by a
      // program too (tmux `split-window … -- cat`), and those are correct.
      return /wsl/i.test(text) && pattern.test(text)
    })

    expect(offenders.map((file) => relative(repoRoot, file))).toEqual([])
  })

  it('sees a `--` separator split across lines by the formatter', () => {
    // Why: the guard once matched line-by-line and was blind to this exact shape,
    // which is how every multi-element argv array in this repo is formatted.
    const formatted = ['args: [', "  '-d',", '  distro,', "  '--',", "  'bash'", ']'].join('\n')

    expect(ARGV_FORM.test(codeText(formatted))).toBe(true)
  })
})
