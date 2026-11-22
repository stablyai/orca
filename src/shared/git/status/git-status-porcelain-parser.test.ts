import { describe, expect, it } from 'vitest'
import { StatusPorcelainParser } from './git-status-porcelain-parser'

describe('StatusPorcelainParser', () => {
  it('parses type-2 rename records with old path after the tab', () => {
    const parser = new StatusPorcelainParser()
    parser.update('2 R. N... 100644 100644 100644 aaaa bbbb R100 new.ts\told.ts\n', 0)
    parser.finish()
    expect(parser.entries).toEqual([
      { path: 'new.ts', status: 'renamed', area: 'staged', oldPath: 'old.ts' }
    ])
  })

  it('carries a partial trailing line across chunk boundaries', () => {
    const parser = new StatusPorcelainParser()
    parser.update('? partial', 0)
    parser.update('-name.txt\n', 0)
    parser.finish()
    expect(parser.entries).toEqual([
      { path: 'partial-name.txt', status: 'untracked', area: 'untracked' }
    ])
  })

  it('preserves deferred conflicts in status output order', () => {
    const parser = new StatusPorcelainParser()
    parser.update(
      '? before.ts\n' +
        'u UU N... 100644 100644 100644 100644 aa bb cc conflict.ts\n' +
        '? after.ts\n',
      0
    )

    expect(parser.statusRecords).toEqual([
      {
        type: 'entry',
        entry: { path: 'before.ts', status: 'untracked', area: 'untracked' }
      },
      {
        type: 'unmerged',
        line: 'u UU N... 100644 100644 100644 100644 aa bb cc conflict.ts'
      },
      {
        type: 'entry',
        entry: { path: 'after.ts', status: 'untracked', area: 'untracked' }
      }
    ])
  })

  it('splices expanded untracked directories in place and cuts at the limit like -uall', () => {
    const parser = new StatusPorcelainParser()
    parser.update(
      '1 .M N... 100644 100644 100644 aa bb tracked.ts\n? a/\n? b.txt\n? c/\n? d.txt\n',
      0
    )
    parser.finish()
    const exceeded = parser.expandUntrackedDirectories(
      new Map([
        ['a/', ['a/1', 'a/x/2']],
        ['c/', ['c/3', 'c/4']]
      ]),
      5
    )
    expect(exceeded).toBe(true)
    expect(parser.statusLength).toBe(6)
    expect(parser.entries.map((entry) => entry.path)).toEqual([
      'tracked.ts',
      'a/1',
      'a/x/2',
      'b.txt',
      'c/3',
      'c/4'
    ])
  })
})
