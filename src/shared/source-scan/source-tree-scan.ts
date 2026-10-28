import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Share ratchet walks so file selection cannot drift; scanning vendored cross-version checkouts once reported 21 shipped-release offenders. */

const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'out', 'build', '.git'])

/** Tests may do the thing the guard forbids; that is often why they exist. */
export function isTestFile(relativePath: string): boolean {
  return (
    /\.(?:test|spec)\.tsx?$/.test(relativePath) ||
    // Require a whole repro token; substring matching exempted shipped windows-terminal-capability-reprobe.ts.
    /(?:test-harness|test-utils|test-setup|test-fixture|\brepro\b|reproduction)/.test(
      relativePath
    ) ||
    relativePath.includes('/__tests__/')
  )
}

export type ScannedFile = { path: string; relativePath: string; source: string }

type DirentTypeProbe = {
  isSymbolicLink(): boolean
  isFile(): boolean
  isDirectory(): boolean
}

/** Symlinks and DT_UNKNOWN (all type predicates false) need stat or whole real subtrees disappear from guards. */
export function directoryEntryNeedsStat(entry: DirentTypeProbe): boolean {
  return entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())
}

/** Skip dot-directories containing generated/vendor trees, including cross-version checkouts; extensions controls file selection. */
export function scanSourceTree(
  root: string,
  options: { includeTests?: boolean; extensions?: RegExp } = {}
): ScannedFile[] {
  const extensions = options.extensions ?? /\.tsx?$/
  const found: ScannedFile[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = entry.name
      if (IGNORED_DIRECTORIES.has(name) || name.startsWith('.') || name === '__fixtures__') {
        continue
      }
      const path = join(directory, name)
      if (directoryEntryNeedsStat(entry) ? statSync(path).isDirectory() : entry.isDirectory()) {
        visit(path)
        continue
      }
      if (!extensions.test(name)) {
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

/** Track quotes when blanking comments: a glob inside a template once looked like slash-star and hid 24,000 live-code characters. */
export function stripComments(source: string): string {
  let out = ''
  let index = 0
  let quote: string | null = null
  while (index < source.length) {
    const char = source[index]!
    const next = source[index + 1]
    if (quote) {
      // Only templates span lines; reset stray prose/regex quotes so later comments still strip.
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
      // Preserve source line numbers.
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

/** Callers must count desync as an offender; lost lexer state has repeatedly hidden live calls and falsely lowered guard counts. */
export function blankStringContentsDesynced(source: string): boolean {
  return blankStringContents(source, true) !== ''
}

/** Keep regex openers narrow: a missed regex can desync and fail closed, but a false positive silently blanks live calls.
 * Exclude postfix/value endings (! + - * % ^ ~ > }) even with possible prefix readings; wider sets swallowed JSX and execFile after n-- / 2. */
function startsRegexLiteral(prev: string | undefined): boolean {
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
  let lastSignificantChar: string | undefined
  let index = 0
  let quote: string | null = null
  // Track nested braces per template interpolation; an object’s closing brace must not end the interpolation.
  const templates: number[] = []
  while (index < source.length) {
    const char = source[index]!
    if (quote === '`' && char === '$' && source[index + 1] === '{') {
      templates.push(0)
      quote = null
      out += '${'
      lastSignificantChar = '{'
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
          lastSignificantChar = char
          index += 1
          continue
        }
        templates[templates.length - 1] = depth - 1
      }
    }
    if (quote) {
      // Reset non-template quotes on newline so regex apostrophes cannot hide subsequent calls.
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
        lastSignificantChar = char
      } else {
        out += char === '\n' ? char : ' '
      }
      index += 1
      continue
    }
    // Regex apostrophes must not open strings; use the narrow prior-token heuristic.
    // Comments are never regexes, including at index zero when this blanker runs without stripComments.
    const next = source[index + 1]
    if (char === '/' && next !== '/' && next !== '*' && startsRegexLiteral(lastSignificantChar)) {
      const end = findRegexLiteralEnd(source, index)
      if (end !== -1) {
        out += `/${' '.repeat(end - index - 1)}`
        lastSignificantChar = '/'
        index = end
        continue
      }
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
    }
    out += char
    if (/\S/.test(char)) {
      lastSignificantChar = char
    }
    index += 1
  }
  if (reportDesync) {
    return quote !== null || templates.length > 0 ? 'desynced' : ''
  }
  return out
}
