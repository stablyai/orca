import { execFile } from 'node:child_process'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { gitChangeListArgs, parseGitChangeList } from './git-change-list'

const execFileAsync = promisify(execFile)
const raw = (status: string, ...paths: string[]): string =>
  `:100644 100644 abc def ${status}\0${paths.join('\0')}\0`

describe('Git change lists', () => {
  it('reads compact NUL name/status records with literal paths and rename pairs', () => {
    const path = ':tab\tnewline\n"日本語" => file'
    const records = `M\0${path}\0R100\0old\0new\0C080\0source\0copy\0T\0type\0`
    expect(parseGitChangeList(records, 'name-status')).toEqual([
      { path, status: 'modified' },
      { path: 'new', oldPath: 'old', status: 'renamed' },
      { path: 'copy', oldPath: 'source', status: 'copied' },
      { path: 'type', status: 'modified' }
    ])
    expect(parseGitChangeList('', 'name-status')).toEqual([])
    expect(() => parseGitChangeList('R100\0old\0', 'name-status')).toThrow('Incomplete')
    expect(() => parseGitChangeList('invalid\0path\0', 'name-status')).toThrow('Invalid')
    expect(() => parseGitChangeList('M\0\0', 'name-status')).toThrow('Missing')
  })

  it('preserves delimiters, quotes, Unicode and rename markers in paths', () => {
    const name = ':tab\tnewline\n"日本語" => file'
    const oldPath = 'old\t\nfile'
    expect(
      parseGitChangeList(
        [
          raw('M', name),
          raw('R100', oldPath, 'new'),
          `2\t1\t${name}\0`,
          '0\t0\t\0old\t\nfile\0new\0'
        ].join('')
      )
    ).toEqual([
      { path: name, status: 'modified', added: 2, removed: 1 },
      { path: 'new', oldPath, status: 'renamed', added: 0, removed: 0 }
    ])
  })

  it('keeps copies, binary changes and type changes', () => {
    expect(
      parseGitChangeList(
        [
          raw('C080', 'source', 'copy'),
          raw('M', 'binary'),
          raw('T', 'type'),
          '1\t0\t\0source\0copy\0',
          '-\t-\tbinary\0',
          '0\t0\ttype\0'
        ].join('')
      )
    ).toEqual([
      { path: 'copy', oldPath: 'source', status: 'copied', added: 1, removed: 0 },
      { path: 'binary', status: 'modified', added: undefined, removed: undefined },
      { path: 'type', status: 'modified', added: 0, removed: 0 }
    ])
  })

  it('handles empty output and rejects truncated paths rather than partial changes', () => {
    expect(parseGitChangeList('')).toEqual([])
    expect(() => parseGitChangeList(':100644 100644 a b M\0unterminated')).toThrow('Incomplete')
    expect(() => parseGitChangeList(raw('R100', 'old'))).toThrow('Incomplete')
    expect(() => parseGitChangeList(':invalid\0name\0')).toThrow('Invalid')
  })

  it('reads root, branch and parent comparisons from a real repository', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'orca-change-list-'))
    const git = async (args: string[]): Promise<string> => {
      const { stdout } = await execFileAsync('git', args, { cwd: repo })
      return stdout
    }
    try {
      await git(['init', '-q'])
      await git(['config', 'user.email', 'test@example.invalid'])
      await git(['config', 'user.name', 'Test'])
      await git(['config', 'commit.gpgSign', 'false'])
      await writeFile(join(repo, 'source'), 'one\ntwo\n')
      await writeFile(join(repo, 'old'), 'unique rename contents\n')
      await writeFile(join(repo, 'deleted'), 'delete\n')
      await writeFile(join(repo, 'binary'), Buffer.from([0, 1]))
      await git(['add', '.'])
      await git(['commit', '-qm', 'root'])
      const base = (await git(['rev-parse', 'HEAD'])).trim()
      expect(parseGitChangeList(await git(gitChangeListArgs(null, base)))).toEqual([
        { path: 'binary', status: 'added', added: undefined, removed: undefined },
        { path: 'deleted', status: 'added', added: 1, removed: 0 },
        { path: 'old', status: 'added', added: 1, removed: 0 },
        { path: 'source', status: 'added', added: 2, removed: 0 }
      ])
      const renamed = process.platform === 'win32' ? 'new' : 'new\t\n日本語 => file'
      await rename(join(repo, 'old'), join(repo, renamed))
      await rm(join(repo, 'deleted'))
      await writeFile(join(repo, 'copy'), 'one\ntwo\n')
      await writeFile(join(repo, 'source'), 'one\ntwo\nthree\n')
      await writeFile(join(repo, 'binary'), Buffer.from([0, 2]))
      await writeFile(join(repo, 'empty'), '')
      await git(['add', '.'])
      await git(['commit', '-qm', 'changes'])
      const head = (await git(['rev-parse', 'HEAD'])).trim()
      const entries = parseGitChangeList(await git(gitChangeListArgs(base, head)))
      expect(entries).toEqual(
        expect.arrayContaining([
          { path: 'binary', status: 'modified', added: undefined, removed: undefined },
          { path: 'copy', oldPath: 'source', status: 'copied', added: 0, removed: 0 },
          { path: 'deleted', status: 'deleted', added: 0, removed: 1 },
          { path: 'empty', status: 'added', added: 0, removed: 0 },
          { path: renamed, oldPath: 'old', status: 'renamed', added: 0, removed: 0 },
          { path: 'source', status: 'modified', added: 1, removed: 0 }
        ])
      )
      expect(entries).toHaveLength(6)
      expect(
        parseGitChangeList(
          await git(['diff', '--name-status', '-z', '-M', '-C', base, head, '--']),
          'name-status'
        )
      ).toEqual(entries.map(({ added: _added, removed: _removed, ...entry }) => entry))
      expect(parseGitChangeList(await git(gitChangeListArgs(head, head)))).toEqual([])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
