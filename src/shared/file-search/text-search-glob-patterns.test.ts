import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { splitSearchGlobPatterns } from './text-search-glob-patterns'
import { buildGitGrepArgs } from './text-search'

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

  it('preserves 20000 nested groups without expanding alternatives', () => {
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
