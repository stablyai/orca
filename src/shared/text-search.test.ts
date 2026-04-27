import { describe, expect, it } from 'vitest'
import {
  buildGitGrepArgs,
  buildRgArgs,
  buildSubmatchRegex,
  createAccumulator,
  finalize,
  ingestGitGrepLine,
  ingestRgJsonLine,
  MAX_LINE_CONTENT_LENGTH,
  normalizeRelativePath,
  toGitGlobPathspec
} from './text-search'

describe('normalizeRelativePath', () => {
  it('collapses mixed separators and strips leading slashes', () => {
    expect(normalizeRelativePath('a\\b\\c')).toBe('a/b/c')
    expect(normalizeRelativePath('/a/b')).toBe('a/b')
    expect(normalizeRelativePath('///a//b')).toBe('a/b')
  })
})

describe('buildRgArgs', () => {
  it('defaults to case-insensitive, fixed-strings, hidden, exclude .git', () => {
    const args = buildRgArgs('needle', '/root', {})
    expect(args).toContain('--json')
    expect(args).toContain('--hidden')
    expect(args).toContain('--ignore-case')
    expect(args).toContain('--fixed-strings')
    expect(args.indexOf('!.git')).toBeGreaterThan(args.indexOf('--glob'))
    expect(args.slice(-3)).toEqual(['--', 'needle', '/root'])
  })

  it('honors caseSensitive, wholeWord, useRegex', () => {
    const args = buildRgArgs('q', '/r', { caseSensitive: true, wholeWord: true, useRegex: true })
    expect(args).not.toContain('--ignore-case')
    expect(args).toContain('--word-regexp')
    expect(args).not.toContain('--fixed-strings')
  })

  it('splits comma-separated include/exclude patterns', () => {
    const args = buildRgArgs('q', '/r', { includePattern: '*.ts, *.tsx', excludePattern: '*.md' })
    expect(args).toContain('*.ts')
    expect(args).toContain('*.tsx')
    expect(args).toContain('!*.md')
  })
})

describe('ingestRgJsonLine', () => {
  const makeMatch = (
    path: string,
    line: number,
    subs: { start: number; end: number }[],
    text = 'abc'
  ) =>
    JSON.stringify({
      type: 'match',
      data: {
        path: { text: path },
        line_number: line,
        lines: { text: `${text}\n` },
        submatches: subs
      }
    })

  it('populates accumulator for a match', () => {
    const acc = createAccumulator()
    const verdict = ingestRgJsonLine(
      makeMatch('/root/src/a.ts', 2, [{ start: 0, end: 3 }]),
      '/root',
      acc,
      100
    )
    expect(verdict).toBe('continue')
    expect(acc.totalMatches).toBe(1)
    const files = Array.from(acc.fileMap.values())
    expect(files[0].relativePath).toBe('src/a.ts')
    expect(files[0].matches[0]).toEqual({ line: 2, column: 1, matchLength: 3, lineContent: 'abc' })
  })

  it('ignores non-match messages', () => {
    const acc = createAccumulator()
    ingestRgJsonLine(JSON.stringify({ type: 'begin', data: {} }), '/root', acc, 100)
    expect(acc.totalMatches).toBe(0)
  })

  it('skips malformed JSON', () => {
    const acc = createAccumulator()
    const verdict = ingestRgJsonLine('not json', '/root', acc, 100)
    expect(verdict).toBe('continue')
    expect(acc.totalMatches).toBe(0)
  })

  it('stops at maxResults and sets truncated synchronously', () => {
    const acc = createAccumulator()
    const verdict = ingestRgJsonLine(
      makeMatch('/root/a.ts', 1, [
        { start: 0, end: 1 },
        { start: 2, end: 3 },
        { start: 4, end: 5 }
      ]),
      '/root',
      acc,
      2
    )
    expect(verdict).toBe('stop')
    expect(acc.truncated).toBe(true)
    expect(acc.totalMatches).toBe(2)
  })

  it('clamps huge lineContent around the match to bound payload size', () => {
    const acc = createAccumulator()
    const huge = `${'x'.repeat(200_000)}NEEDLE${'y'.repeat(200_000)}`
    const matchStart = 200_000
    ingestRgJsonLine(
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: '/root/big.js' },
          line_number: 1,
          lines: { text: `${huge}\n` },
          submatches: [{ start: matchStart, end: matchStart + 6 }]
        }
      }),
      '/root',
      acc,
      100
    )
    const match = Array.from(acc.fileMap.values())[0].matches[0]
    expect(match.lineContent.length).toBeLessThanOrEqual(MAX_LINE_CONTENT_LENGTH + 2)
    expect(match.column).toBe(matchStart + 1)
    expect(match.matchLength).toBe(6)
    expect(match.displayColumn).toBeDefined()
    expect(match.displayMatchLength).toBe(6)
    // Extracted column should still align with NEEDLE inside the snippet.
    const displayColumn = match.displayColumn ?? match.column
    const displayMatchLength = match.displayMatchLength ?? match.matchLength
    const sliced = match.lineContent.slice(
      displayColumn - 1,
      displayColumn - 1 + displayMatchLength
    )
    expect(sliced).toBe('NEEDLE')
  })

  it('applies transformAbsPath (WSL translation)', () => {
    const acc = createAccumulator()
    ingestRgJsonLine(
      makeMatch('/home/u/repo/a.ts', 1, [{ start: 0, end: 1 }]),
      '\\\\wsl$\\Ubuntu\\home\\u\\repo',
      acc,
      100,
      (p) => p.replace('/home/u/repo', '\\\\wsl$\\Ubuntu\\home\\u\\repo')
    )
    const files = Array.from(acc.fileMap.values())
    // Transform replaces the root prefix; tail separators are as rg emitted them.
    expect(files[0].filePath).toBe('\\\\wsl$\\Ubuntu\\home\\u\\repo/a.ts')
  })
})

describe('buildGitGrepArgs', () => {
  it('adds -i, --fixed-strings and `.` default pathspec', () => {
    const args = buildGitGrepArgs('q', {})
    expect(args).toContain('-i')
    expect(args).toContain('--fixed-strings')
    expect(args).toContain('--no-recurse-submodules')
    expect(args.at(-1)).toBe('.')
  })

  it('uses --extended-regexp when useRegex is true', () => {
    const args = buildGitGrepArgs('q', { useRegex: true })
    expect(args).toContain('--extended-regexp')
    expect(args).not.toContain('--fixed-strings')
  })

  it('includes/excludes use :(glob) pathspecs', () => {
    const args = buildGitGrepArgs('q', { includePattern: '*.ts', excludePattern: 'dist/**' })
    expect(args).toContain(':(glob)**/*.ts')
    expect(args).toContain(':(exclude,glob)dist/**')
  })
})

describe('toGitGlobPathspec', () => {
  it('wraps bare globs with **/ to match recursively', () => {
    expect(toGitGlobPathspec('*.ts')).toBe(':(glob)**/*.ts')
    expect(toGitGlobPathspec('src/*.ts')).toBe(':(glob)src/*.ts')
    expect(toGitGlobPathspec('*.ts', true)).toBe(':(exclude,glob)**/*.ts')
  })
})

describe('buildSubmatchRegex', () => {
  it('escapes literal query by default, gi flags', () => {
    const re = buildSubmatchRegex('a.b', {})
    expect(re?.flags).toBe('gi')
    expect(re?.source).toBe('a\\.b')
  })

  it('wholeWord wraps in \\b', () => {
    const re = buildSubmatchRegex('foo', { wholeWord: true })
    expect(re?.source).toBe('\\bfoo\\b')
  })

  it('useRegex passes through', () => {
    const re = buildSubmatchRegex('a|b', { useRegex: true, caseSensitive: true })
    expect(re?.source).toBe('a|b')
    expect(re?.flags).toBe('g')
  })

  it('returns null for queries git grep accepts but JS RegExp rejects', () => {
    // Unbalanced group — git grep ERE accepts it as literal, JS RegExp throws.
    expect(buildSubmatchRegex('(foo', { useRegex: true })).toBeNull()
    // Unterminated character class.
    expect(buildSubmatchRegex('[abc', { useRegex: true })).toBeNull()
  })
})

describe('ingestGitGrepLine', () => {
  it('parses null-byte delimited line, finds all submatch positions', () => {
    const acc = createAccumulator()
    const re = buildSubmatchRegex('foo', {})
    const verdict = ingestGitGrepLine('src/a.ts\x005:foo and foo again\n', '/root', re, acc, 100)
    expect(verdict).toBe('continue')
    const f = Array.from(acc.fileMap.values())[0]
    expect(f.matches).toHaveLength(2)
    expect(f.matches[0]).toMatchObject({ line: 5, column: 1 })
    expect(f.matches[1]).toMatchObject({ line: 5, column: 9 })
  })

  it('handles colons in filenames via null delimiter', () => {
    const acc = createAccumulator()
    const re = buildSubmatchRegex('x', {})
    ingestGitGrepLine('weird:name.ts\x001:x', '/root', re, acc, 100)
    const f = Array.from(acc.fileMap.values())[0]
    expect(f.relativePath).toBe('weird:name.ts')
  })

  it('skips malformed lines (no null, no colon, bad line num)', () => {
    const acc = createAccumulator()
    const re = buildSubmatchRegex('q', {})
    ingestGitGrepLine('no-null-byte', '/r', re, acc, 100)
    ingestGitGrepLine('a.ts\x00no-colon', '/r', re, acc, 100)
    ingestGitGrepLine('a.ts\x00NaN:content', '/r', re, acc, 100)
    expect(acc.totalMatches).toBe(0)
  })

  it('zero-length regex does not loop', () => {
    const acc = createAccumulator()
    // A pattern that matches zero-length at every position.
    const re = new RegExp('', 'g')
    ingestGitGrepLine('a.ts\x001:abc', '/r', re, acc, 5)
    expect(acc.totalMatches).toBeGreaterThan(0)
    expect(acc.totalMatches).toBeLessThanOrEqual(5)
  })

  it('stops at maxResults boundary and sets truncated synchronously', () => {
    const acc = createAccumulator()
    const re = buildSubmatchRegex('a', {})
    const verdict = ingestGitGrepLine('f\x001:aaaa', '/r', re, acc, 2)
    expect(verdict).toBe('stop')
    expect(acc.truncated).toBe(true)
    expect(acc.totalMatches).toBe(2)
  })

  it('falls back to whole-line highlight when submatchRegex is null', () => {
    const acc = createAccumulator()
    const verdict = ingestGitGrepLine('a.ts\x003:hello world', '/r', null, acc, 100)
    expect(verdict).toBe('continue')
    const f = Array.from(acc.fileMap.values())[0]
    expect(f.matches).toHaveLength(1)
    expect(f.matches[0]).toMatchObject({
      line: 3,
      column: 1,
      matchLength: 'hello world'.length,
      lineContent: 'hello world'
    })
  })
})

describe('finalize', () => {
  it('returns the expected SearchResult shape', () => {
    const acc = createAccumulator()
    acc.fileMap.set('/r/a.ts', { filePath: '/r/a.ts', relativePath: 'a.ts', matches: [] })
    acc.totalMatches = 3
    acc.truncated = true
    expect(finalize(acc)).toEqual({
      files: [{ filePath: '/r/a.ts', relativePath: 'a.ts', matches: [] }],
      totalMatches: 3,
      truncated: true
    })
  })
})
