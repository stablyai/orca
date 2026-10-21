import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { buildRgArgs, createAccumulator, ingestRgJsonLine } from './text-search'

describe('text search match budgets', () => {
  it.each(['x', '😀'])(
    'keeps whole Unicode context around dense real rg matches for %s',
    async (query) => {
      const { rgPath } = await import('@vscode/ripgrep-universal')
      const root = await mkdtemp(join(tmpdir(), 'orca-rg-dense-unicode-'))
      const filename = join(root, 'unicode.txt')
      try {
        await writeFile(filename, `a${'😀x'.repeat(10_000)}\n`)
        const result = await runProcess({
          program: rgPath,
          args: buildRgArgs(query, '.', {}),
          cwd: root
        })
        expect(result.code).toBe(0)
        const accumulator = createAccumulator()
        for (const line of result.stdout.split('\n')) {
          if (ingestRgJsonLine(line, root, accumulator, 2000) === 'stop') {
            break
          }
        }
        expect(accumulator.totalMatches).toBe(2000)
        const matches = accumulator.fileMap.get(filename)?.matches ?? []
        expect(matches).toHaveLength(2000)
        for (const [index, match] of matches.entries()) {
          expect(match.column).toBe(index * 3 + (query === 'x' ? 4 : 2))
          expect(match.matchLength).toBe(query.length)
          expect(match.lineContent.isWellFormed()).toBe(true)
          const start = (match.displayColumn ?? match.column) - 1
          const length = match.displayMatchLength ?? match.matchLength
          expect(match.lineContent.slice(start, start + length)).toBe(query)
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it('keeps dense-line columns after a leading U+FEFF from real rg', async () => {
    const { rgPath } = await import('@vscode/ripgrep-universal')
    const root = await mkdtemp(join(tmpdir(), 'orca-rg-dense-bom-'))
    const filename = join(root, '\ufeffdense.txt')
    try {
      await writeFile(filename, `header\n\ufeff${'x '.repeat(10_000)}`)
      const result = await runProcess({
        program: rgPath,
        args: buildRgArgs('x', '.', {}),
        cwd: root
      })
      expect(result.code).toBe(0)
      const accumulator = createAccumulator()
      for (const line of result.stdout.split('\n')) {
        if (ingestRgJsonLine(line, root, accumulator, 2000) === 'stop') {
          break
        }
      }
      expect(accumulator.totalMatches).toBe(2000)
      expect(accumulator.fileMap.get(filename)?.matches[0]).toMatchObject({
        line: 2,
        column: 2,
        matchLength: 1
      })
      expect(accumulator.fileMap.get(filename)?.matches[1999]?.column).toBe(4000)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves the requested budget from real rg dense-line output', async () => {
    const { rgPath } = await import('@vscode/ripgrep-universal')
    const root = await mkdtemp(join(tmpdir(), 'orca-rg-dense-'))
    try {
      await writeFile(join(root, 'dense.txt'), 'x '.repeat(10_000))
      const result = await runProcess({
        program: rgPath,
        args: buildRgArgs('x', root, {}),
        cwd: root
      })
      expect(result.code).toBe(0)
      const accumulator = createAccumulator()
      for (const line of result.stdout.split('\n')) {
        if (ingestRgJsonLine(line, root, accumulator, 2000) === 'stop') {
          break
        }
      }
      expect(accumulator.totalMatches).toBe(2000)
      expect(accumulator.truncated).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('allows more than 100 matching lines in one file under the global budget', async () => {
    const { rgPath } = await import('@vscode/ripgrep-universal')
    const root = await mkdtemp(join(tmpdir(), 'orca-rg-lines-'))
    try {
      await writeFile(join(root, 'many.txt'), 'needle\n'.repeat(150))
      const result = await runProcess({
        program: rgPath,
        args: buildRgArgs('needle', root, {}),
        cwd: root
      })
      expect(result.code).toBe(0)
      const accumulator = createAccumulator()
      for (const line of result.stdout.split('\n')) {
        ingestRgJsonLine(line, root, accumulator, 2000)
      }
      expect(accumulator.totalMatches).toBe(150)
      expect(accumulator.truncated).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function denseRecord(count: number): string {
  return JSON.stringify({
    type: 'match',
    data: {
      path: { text: '/root/dense.txt' },
      lines: { text: 'x '.repeat(count) },
      line_number: 1,
      submatches: Array.from({ length: count }, (_, index) => ({
        match: { text: 'x' },
        start: index * 2,
        end: index * 2 + 1
      }))
    }
  })
}

it('retains the first 2000 matches from a dense line beyond the normal JSON budget', () => {
  const accumulator = createAccumulator()
  expect(ingestRgJsonLine(denseRecord(10_000), '/root', accumulator, 2000)).toBe('stop')
  expect(accumulator.totalMatches).toBe(2000)
  expect(accumulator.truncated).toBe(true)
  const matches = accumulator.fileMap.get('/root/dense.txt')?.matches
  expect(matches?.map((match) => match.column)).toEqual(
    Array.from({ length: 2000 }, (_, index) => index * 2 + 1)
  )
})

it.each([
  (record: string) => record.slice(0, -1),
  (record: string) => `${record.slice(0, -2)},invalid}`,
  (record: string) => `${record.slice(0, -1)},"data":{}}`,
  (record: string) => `${record.slice(0, -2)},"submatches":[]}}`
])(
  'rejects invalid tails or duplicate envelope keys without retaining early matches',
  (corrupt) => {
    const accumulator = createAccumulator()
    ingestRgJsonLine(corrupt(denseRecord(10_000)), '/root', accumulator, 2000)
    expect(accumulator.totalMatches).toBe(0)
    expect(accumulator.truncated).toBe(true)
  }
)
