import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
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
    ['', []],
    [' , *.ts,, *.md, ', ['*.ts', '*.md']],
    ['}.ts, *.md', ['}.ts', '*.md']],
    ['*.{ts,tsx}, *.md', ['*.{ts,tsx}', '*.md']],
    ['{src,{lib,test}}/**, *.md', ['{src,{lib,test}}/**', '*.md']],
    ['*[a,b].ts, *.md', ['*[a,b].ts', '*.md']],
    ['[{},].ts, *.md', ['[{},].ts', '*.md']],
    ['[]a,b].ts, *.md', ['[]a,b].ts', '*.md']],
    ['[!]a,b].ts, *.md', ['[!]a,b].ts', '*.md']],
    ['[^]a,b].ts, *.md', ['[^]a,b].ts', '*.md']],
    ['[[:alpha:],].ts, *.md', ['[[:alpha:],].ts', '*.md']],
    ['[a\\],b].ts, *.md', ['[a\\],b].ts', '*.md']],
    ['foo\\,bar/**, *.ts', ['foo\\,bar/**', '*.ts']],
    ['\\{a,b\\}, *.ts', ['\\{a', 'b\\}', '*.ts']],
    ['\\[a,b\\], *.ts', ['\\[a', 'b\\]', '*.ts']],
    ['src\\', ['src\\']],
    ['*.{ts,tsx', ['*.{ts,tsx']],
    ['[a,b', ['[a,b']]
  ])('preserves grouped and escaped commas in %s', (input, expected) => {
    expect(splitSearchGlobPatterns(input, 'git')).toEqual(expected)
  })

  it('scans deeply nested groups without recursion or expanding alternatives', () => {
    const pattern = `${'{'.repeat(20_000)}a,b${'}'.repeat(20_000)}`
    expect(splitSearchGlobPatterns(`${pattern}, *.md`)).toEqual([pattern, '*.md'])
  })
})

describe('file search with real search engines', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-search-globs-'))
    for (const file of ['a.ts', 'b.tsx', 'c.md', ',.ts']) {
      await writeFile(join(root, file), 'needle\n')
    }
    const initialized = await runProcess({ program: 'git', args: ['init'], cwd: root })
    expect(initialized.code).toBe(0)
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
    [{ includePattern: '[]a,b].ts, *.md' }, [',.ts', 'a.ts', 'c.md']],
    [{ excludePattern: '[a,b].ts' }, ['b.tsx', 'c.md']],
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

  it.each(['*.{ts,tsx', '[a,b'])('leaves invalid %s for ripgrep to reject', async (pattern) => {
    const { rgPath } = await import('@vscode/ripgrep-universal')
    for (const options of [{ includePattern: pattern }, { excludePattern: pattern }]) {
      const result = await runProcess({
        program: rgPath,
        args: buildRgArgs('needle', root, options),
        cwd: root
      })
      expect(result.code).toBe(2)
      expect(result.stderr).toContain('error parsing glob')
      expect(result.stderr).toContain(pattern)
    }
  })

  it('keeps Git brace syntax literal instead of expanding it', async () => {
    const result = await runProcess({
      program: 'git',
      args: buildGitGrepArgs('needle', { includePattern: '*.{ts,tsx}' }),
      cwd: root
    })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  it('preserves character classes in Git exclusions', async () => {
    const result = await runProcess({
      program: 'git',
      args: buildGitGrepArgs('needle', { excludePattern: '[[:alpha:],].ts' }),
      cwd: root
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('b.tsx\0')
    expect(result.stdout).toContain('c.md\0')
    expect(result.stdout).not.toContain('a.ts\0')
    expect(result.stdout).not.toContain(',.ts\0')
  })

  it.each(['[a,b].ts', '[[:alpha:],].ts'])(
    'preserves %s in the Git fallback too',
    async (includePattern) => {
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

describe('engine-specific character classes', () => {
  let root: string
  const files = [',.ts', '[.ts', '].ts', 'a.ts', 'a,b].ts', 'b.tsx', 'c.md']

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-search-class-syntax-'))
    for (const file of files) {
      await writeFile(join(root, file), 'needle\n')
    }
    expect((await runProcess({ program: 'git', args: ['init'], cwd: root })).code).toBe(0)
  })

  afterAll(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['rg', '[a\\].ts, *.md', ['a.ts', 'c.md']],
    ['rg', '[[:].ts, *.md', ['[.ts', 'c.md']],
    ['git', '[[:].ts, *.md', ['[.ts', 'c.md']],
    ['git', '[a\\],b].ts, *.md', [',.ts', '].ts', 'a.ts', 'c.md']],
    ['git', '[[:alpha:],].ts, *.md', [',.ts', 'a.ts', 'c.md']],
    ['rg', '[[:alpha:], *.md', ['c.md']]
  ] as const)(
    'respects %s syntax in %s for includes and excludes',
    async (engine, pattern, matches) => {
      const { rgPath } = await import('@vscode/ripgrep-universal')
      for (const exclude of [false, true]) {
        const options = exclude ? { excludePattern: pattern } : { includePattern: pattern }
        const result = await runProcess({
          program: engine === 'rg' ? rgPath : 'git',
          args:
            engine === 'rg'
              ? buildRgArgs('needle', root, options)
              : buildGitGrepArgs('needle', options),
          cwd: root
        })
        expect(result.code).toBe(0)
        expect(result.stderr).toBe('')
        let actual: string[]
        if (engine === 'rg') {
          const accumulator = createAccumulator()
          for (const line of result.stdout.split('\n')) {
            ingestRgJsonLine(line, root, accumulator, 100)
          }
          actual = finalize(accumulator).files.map((file) => file.relativePath)
        } else {
          actual = result.stdout
            .trim()
            .split('\n')
            .map((line) => line.split('\0')[0])
        }
        const selected = new Set<string>(matches)
        const expected = exclude ? files.filter((file) => !selected.has(file)) : [...matches]
        expect(actual.sort()).toEqual(expected.sort())
      }
    }
  )
})
