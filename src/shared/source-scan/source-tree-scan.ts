import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Shared file walk for the ratchet guards.
 *
 * Why one copy: four guards had grown their own `collectSourceFiles` /
 * `isTestFile` / allowlist reader, and they had already drifted -- one skipped
 * dot-directories and three did not, which is how the WSL separator guard came
 * to scan `tests/e2e/.cross-version-checkouts/` and report 21 offenders that
 * were copies of shipped releases. A guard that can be wrong about what it
 * scanned is worse than no guard, because its count is the goalpost.
 */

const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'out', 'build', '.git'])

/** Tests may do the thing the guard forbids; that is often why they exist. */
export function isTestFile(relativePath: string): boolean {
  return (
    /\.(?:test|spec)\.tsx?$/.test(relativePath) ||
    // `repro` must be a whole token: a bare substring exempted the shipped
    // windows-terminal-capability-reprobe.ts from every guard using this walk.
    /(?:test-harness|test-utils|test-setup|test-fixture|\brepro\b|reproduction)/.test(
      relativePath
    ) ||
    relativePath.includes('/__tests__/')
  )
}

export type ScannedFile = { path: string; relativePath: string; source: string }

/**
 * Every `.ts`/`.tsx` file under `root`, with its text.
 *
 * Dot-directories are skipped: they hold generated and vendored trees (the
 * cross-version e2e checkouts among them), which are not ours to fix.
 */
export function scanSourceTree(
  root: string,
  options: { includeTests?: boolean } = {}
): ScannedFile[] {
  const found: ScannedFile[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (IGNORED_DIRECTORIES.has(entry) || entry.startsWith('.') || entry === '__fixtures__') {
        continue
      }
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) {
        visit(path)
        continue
      }
      if (!/\.tsx?$/.test(entry)) {
        continue
      }
      const relativePath = relative(root, path).replace(/\\/g, '/')
      if (!options.includeTests && isTestFile(relativePath)) {
        continue
      }
      found.push({ path, relativePath, source: readFileSync(path, 'utf8') })
    }
  }
  visit(root)
  return found
}

/** Read a ratchet allowlist, dropping comments and blanks. */
export function readAllowlist(fixturePath: string): string[] {
  return readFileSync(fixturePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

/**
 * Comments blanked out, so a construct documented in prose is not counted as code.
 *
 * Why a scanner and not two regexes: a POSIX glob inside a shell script written
 * as a template literal contains a slash-star sequence, and the naive version
 * read that as a comment opener, blanking everything to the next star-slash --
 * 24,000 characters of live code in one file. A guard then read straight past a
 * real unguarded spawn and reported the file clean, which is worse than no
 * guard. Quote state is the difference, so it has to be tracked.
 */
export function stripComments(source: string): string {
  let out = ''
  let index = 0
  let quote: string | null = null
  while (index < source.length) {
    const char = source[index]!
    const next = source[index + 1]
    if (quote) {
      // Only a template literal may span lines. Resetting at a newline stops an
      // apostrophe in prose, or a quote inside a regex literal, from swallowing
      // the rest of the file and disabling comment stripping from there on.
      if (char === '\n' && quote !== '`') {
        quote = null
        out += char
        index += 1
        continue
      }
      if (char === '\\') {
        out += '  '
        index += 2
        continue
      }
      if (char === quote) {
        quote = null
      }
      out += char
      index += 1
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      out += char
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end === -1 ? source.length : end + 2
      // Keep newlines so reported line numbers stay honest.
      out += source.slice(index, stop).replace(/[^\n]/g, ' ')
      index = stop
      continue
    }
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index)
      const stop = end === -1 ? source.length : end
      out += ' '.repeat(stop - index)
      index = stop
      continue
    }
    out += char
    index += 1
  }
  return out
}

/**
 * String contents replaced by spaces, quotes kept.
 *
 * Why: a brace matcher that counts parentheses inside a shell script embedded
 * as a string closes the call early, so the options object -- and any flag in
 * it -- falls outside the matched range and reads as absent.
 */
/**
 * True when the lexer could not keep its bearings through the file.
 *
 * Why callers must check this: three separate attempts to make the blanker
 * exact all shipped with a desync that silently hid real calls, and each time
 * the offender count went DOWN, which read as progress. A scanner that cannot
 * say "I lost track here" will keep under-reporting. Treat a desync as an
 * offender -- over-reporting is a nuisance, under-reporting is a false clean.
 */
export function blankStringContentsDesynced(source: string): boolean {
  return blankStringContents(source, true) !== ''
}

/**
 * After a value `/` is division; after an opener or a binary operator it opens
 * a regex.
 *
 * The set is deliberately narrow, because the two errors are not symmetric. A
 * false negative leaves a pattern unblanked, which at worst desyncs the lexer
 * -- and every caller treats desync as an offender, so it fails closed. A
 * false positive blanks live code, and a scan that cannot see a call reports
 * it clean. A wider set cost 13 real JSX spans (`<Icon size={14} /> : <Icon`)
 * and swallowed a whole `execFile(...)` after `n-- / 2`, with no desync to
 * show for it.
 *
 * So the postfix and value-terminating characters are excluded even though
 * each also has a prefix reading: `!` (non-null assertion vs `!/re/.test(x)`),
 * `+` `-` `*` `%` `^` `~` (postfix `--`/`++`), and `>` `}` (JSX close).
 */
function startsRegexLiteral(emitted: string): boolean {
  const prev = emitted.replace(/\s+$/, '').at(-1)
  return prev === undefined || '(,=:[&|?;'.includes(prev)
}

/** End index (exclusive) of the regex literal opening at `start`, or -1. */
function findRegexLiteralEnd(source: string, start: number): number {
  let inClass = false
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index]
    if (char === '\\') {
      index += 1
      continue
    }
    // A `/` inside `[...]` is literal, so it must not close the pattern.
    if (char === '[') {
      inClass = true
    } else if (char === ']') {
      inClass = false
    } else if (char === '\n') {
      return -1
    } else if (char === '/' && !inClass) {
      return index + 1
    }
  }
  return -1
}

export function blankStringContents(source: string, reportDesync = false): string {
  let out = ''
  let index = 0
  let quote: string | null = null
  // Brace depth per interpolation, so a `}` inside `${ { a: 1 } }` does not
  // close it. A plain counter mistook the first `}` for the closer.
  const templates: number[] = []
  while (index < source.length) {
    const char = source[index]!
    if (quote === '`' && char === '$' && source[index + 1] === '{') {
      templates.push(0)
      quote = null
      out += '${'
      index += 2
      continue
    }
    if (quote === null && templates.length > 0) {
      const depth = templates.at(-1) ?? 0
      if (char === '{') {
        templates[templates.length - 1] = depth + 1
      } else if (char === '}') {
        if (depth === 0) {
          templates.pop()
          quote = '`'
          out += char
          index += 1
          continue
        }
        templates[templates.length - 1] = depth - 1
      }
    }
    if (quote) {
      // Same rule stripComments uses: only a template may span lines, so an
      // apostrophe in a regex literal cannot invert the rest of the file. That
      // desync dropped a real unguarded spawn out of the ratchet.
      if (char === '\n' && quote !== '`') {
        quote = null
        out += char
        index += 1
        continue
      }
      if (char === '\\') {
        out += '  '
        index += 2
        continue
      }
      if (char === quote) {
        quote = null
        out += char
      } else {
        out += char === '\n' ? char : ' '
      }
      index += 1
      continue
    }
    // A regex literal can carry a lone apostrophe (`/'/g` in a shell quoter),
    // which reads as a string opener and desyncs the rest of the file. The
    // classic prev-token test disambiguates it from division: after a value a
    // `/` divides, after an operator or opener it starts a pattern.
    // `/*` and `//` open comments, never patterns. Callers normally strip
    // comments first, but this runs standalone too, and at index 0 a file
    // starting with a banner comment read as one giant regex.
    const next = source[index + 1]
    if (char === '/' && next !== '/' && next !== '*' && startsRegexLiteral(out)) {
      const end = findRegexLiteralEnd(source, index)
      if (end !== -1) {
        out += `/${' '.repeat(end - index - 1)}`
        index = end
        continue
      }
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
    }
    out += char
    index += 1
  }
  if (reportDesync) {
    return quote !== null || templates.length > 0 ? 'desynced' : ''
  }
  return out
}
