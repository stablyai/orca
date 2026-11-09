import { describe, expect, it } from 'vitest'

import {
  buildSubmatchRegex,
  createAccumulator,
  ingestGitGrepLine,
  ingestRgJsonLine
} from './text-search'

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

  it('creates a navigable fallback match when rg omits submatch ranges', () => {
    const acc = createAccumulator()
    const verdict = ingestRgJsonLine(makeMatch('/root/a.ts', 4, [], 'foobar'), '/root', acc, 100)
    expect(verdict).toBe('continue')
    expect(acc.totalMatches).toBe(1)
    const file = Array.from(acc.fileMap.values())[0]
    expect(file.matchCount).toBe(1)
    expect(file.matches).toEqual([{ line: 4, column: 1, matchLength: 1, lineContent: 'foobar' }])
  })

  it('keeps empty-line rg matches navigable when rg omits submatch ranges', () => {
    const acc = createAccumulator()
    ingestRgJsonLine(makeMatch('/root/a.ts', 5, [], ''), '/root', acc, 100)
    const file = Array.from(acc.fileMap.values())[0]
    expect(file.matchCount).toBe(1)
    expect(file.matches).toEqual([{ line: 5, column: 1, matchLength: 0, lineContent: '' }])
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
    expect(Array.from(acc.fileMap.values())[0].matchCount).toBe(2)
  })
})

describe('ingestGitGrepLine', () => {
  it('parses git grep null-delimited line, finds all submatch positions', () => {
    const acc = createAccumulator()
    const re = buildSubmatchRegex('foo', {})
    const verdict = ingestGitGrepLine('src/a.ts\x005\x00foo and foo again\n', '/root', re, acc, 100)
    expect(verdict).toBe('continue')
    const f = Array.from(acc.fileMap.values())[0]
    expect(f.matchCount).toBe(2)
    expect(f.matches).toHaveLength(2)
    expect(f.matches[0]).toMatchObject({ line: 5, column: 1 })
    expect(f.matches[1]).toMatchObject({ line: 5, column: 9 })
  })

  it('keeps compatibility with colon-delimited git grep lines', () => {
    const acc = createAccumulator()
    const re = buildSubmatchRegex('foo', {})
    ingestGitGrepLine('src/a.ts\x005:foo', '/root', re, acc, 100)
    const f = Array.from(acc.fileMap.values())[0]
    expect(f.matchCount).toBe(1)
    expect(f.matches[0]).toMatchObject({ line: 5, column: 1 })
  })

  it('does not treat colons in matched content as the line-number delimiter', () => {
    const acc = createAccumulator()
    const re = buildSubmatchRegex('reportError(', {})
    ingestGitGrepLine(
      "src/a.ts\x0010\x00reportError(err, { action: 'save' })\n",
      '/root',
      re,
      acc,
      100
    )
    const f = Array.from(acc.fileMap.values())[0]
    expect(f.matchCount).toBe(1)
    expect(f.matches).toHaveLength(1)
    expect(f.matches[0]).toMatchObject({ line: 10, column: 1, matchLength: 12 })
  })

  it('handles colons in filenames via null delimiter', () => {
    const acc = createAccumulator()
    const re = buildSubmatchRegex('x', {})
    ingestGitGrepLine('weird:name.ts\x001\x00x', '/root', re, acc, 100)
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

  it('stops at maxResults boundary and sets truncated synchronously', () => {
    const acc = createAccumulator()
    const re = buildSubmatchRegex('a', {})
    const verdict = ingestGitGrepLine('f\x001\x00aaaa', '/r', re, acc, 2)
    expect(verdict).toBe('stop')
    expect(acc.truncated).toBe(true)
    expect(acc.totalMatches).toBe(2)
    expect(Array.from(acc.fileMap.values())[0].matchCount).toBe(2)
  })

  it('falls back to whole-line highlight when submatchRegex is null', () => {
    const acc = createAccumulator()
    const verdict = ingestGitGrepLine('a.ts\x003\x00hello world', '/r', null, acc, 100)
    expect(verdict).toBe('continue')
    const f = Array.from(acc.fileMap.values())[0]
    expect(f.matchCount).toBe(1)
    expect(f.matches).toHaveLength(1)
    expect(f.matches[0]).toMatchObject({
      line: 3,
      column: 1,
      matchLength: 'hello world'.length,
      lineContent: 'hello world'
    })
  })

  it('falls back to whole-line highlight when a valid JS regex finds no submatch', () => {
    const acc = createAccumulator()
    const re = /nomatch/g
    const verdict = ingestGitGrepLine('a.ts\x003\x00git reported this line', '/r', re, acc, 100)
    expect(verdict).toBe('continue')
    const f = Array.from(acc.fileMap.values())[0]
    expect(f.matchCount).toBe(1)
    expect(f.matches).toEqual([
      {
        line: 3,
        column: 1,
        matchLength: 'git reported this line'.length,
        lineContent: 'git reported this line'
      }
    ])
  })
})
