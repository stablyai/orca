import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from './child-process/run-process'
import { splitSearchGlobPatterns } from './text-search-glob-patterns'
import {
  buildGitGrepArgs,
  buildRgArgs,
  createAccumulator,
  finalize,
  ingestRgJsonLine
} from './text-search'

describe('compound search globs', () => {
  it.each([
    ['*.{ts,tsx}, *.md', ['*.{ts,tsx}', '*.md']],
    ['{src,{lib,test}}/**, *.md', ['{src,{lib,test}}/**', '*.md']],
    ['*[a,b].ts, *.md', ['*[a,b].ts', '*.md']],
    ['[{},].ts, *.md', ['[{},].ts', '*.md']],
    ['[]a,b].ts, *.md', ['[]a,b].ts', '*.md']],
    ['[!]a,b].ts, *.md', ['[!]a,b].ts', '*.md']],
    ['[[:alpha:],].ts, *.md', ['[[:alpha:],].ts', '*.md']],
    ['[a\\],b].ts, *.md', ['[a\\],b].ts', '*.md']],
    ['foo\\,bar/**, *.ts', ['foo\\,bar/**', '*.ts']],
    ['\\{a,b\\}, *.ts', ['\\{a', 'b\\}', '*.ts']],
    ['\\[a,b\\], *.ts', ['\\[a', 'b\\]', '*.ts']],
    ['src\\', ['src\\']],
    ['*.{ts,tsx', ['*.{ts,tsx']],
    ['[a,b', ['[a,b']]
  ])('preserves grouped and escaped commas in %s', (input, expected) => {
    expect(splitSearchGlobPatterns(input)).toEqual(expected)
  })
})

describe('file search with real search engines', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-search-globs-'))
    for (const file of ['a.ts', 'b.tsx', 'c.md', ',.ts']) {
      await writeFile(join(root, file), 'needle\n')
    }
  })

  afterAll(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    [{ includePattern: '*.{ts,tsx}' }, [',.ts', 'a.ts', 'b.tsx']],
    [{ includePattern: '[a,b].ts, *.md' }, [',.ts', 'a.ts', 'c.md']],
    [{ excludePattern: '*.{ts,tsx}' }, ['c.md']],
    [{ includePattern: '*.ts, *.tsx', excludePattern: '[a,b].ts' }, ['b.tsx']]
  ])('matches files with ripgrep using %j', async (options, expected) => {
    const { rgPath } = await import('@vscode/ripgrep-universal')
    const result = await runProcess({
      program: rgPath,
      args: buildRgArgs('needle', root, options),
      cwd: root
    })
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    const accumulator = createAccumulator()
    for (const line of result.stdout.split('\n')) {
      ingestRgJsonLine(line, root, accumulator, 100)
    }
    expect(
      finalize(accumulator)
        .files.map((file) => file.relativePath)
        .sort()
    ).toEqual(expected)
  })

  it.each(['[a,b].ts', '[[:alpha:],].ts'])(
    'preserves %s in the Git fallback too',
    async (includePattern) => {
      const initialized = await runProcess({ program: 'git', args: ['init'], cwd: root })
      expect(initialized.code).toBe(0)
      const result = await runProcess({
        program: 'git',
        args: buildGitGrepArgs('needle', { includePattern }),
        cwd: root
      })
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('a.ts\0')
      expect(result.stdout).toContain(',.ts\0')
      expect(result.stdout).not.toContain('b.tsx\0')
      expect(result.stdout).not.toContain('c.md\0')
    }
  )
})
