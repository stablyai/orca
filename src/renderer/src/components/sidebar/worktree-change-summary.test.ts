import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import { summarizeWorktreeChanges } from './worktree-change-summary'

function file(area: GitStatusEntry['area'], path: string): GitStatusEntry {
  return { path, area, status: area === 'untracked' ? 'untracked' : 'modified' }
}

function dirtySubmodule(path: string): GitStatusEntry {
  return {
    path,
    area: 'unstaged',
    status: 'modified',
    submodule: { commitChanged: false, trackedChanges: false, untrackedChanges: true }
  }
}

describe('summarizeWorktreeChanges', () => {
  it('returns zeros for a clean workspace', () => {
    expect(summarizeWorktreeChanges([])).toEqual({
      total: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      submodules: 0
    })
  })

  it('splits entries by staging area', () => {
    const summary = summarizeWorktreeChanges([
      file('staged', 'a.ts'),
      file('unstaged', 'b.ts'),
      file('unstaged', 'c.ts'),
      file('untracked', 'd.ts')
    ])

    expect(summary).toEqual({ total: 4, staged: 1, unstaged: 2, untracked: 1, submodules: 0 })
  })

  it('counts a dirty submodule once, not also as a file', () => {
    // Why: the shape that prompted this — two untracked files plus a dirty
    // submodule reported as one working-tree change, so the row reads 3 while the
    // user only edited two files.
    const summary = summarizeWorktreeChanges([
      dirtySubmodule('design-system'),
      file('untracked', 'one.txt'),
      file('untracked', 'two.txt')
    ])

    expect(summary).toEqual({ total: 3, staged: 0, unstaged: 0, untracked: 2, submodules: 1 })
  })

  it('keeps the parts adding up to the total', () => {
    const entries = [
      file('staged', 'a.ts'),
      file('unstaged', 'b.ts'),
      file('untracked', 'c.ts'),
      dirtySubmodule('vendor/lib')
    ]

    const { total, staged, unstaged, untracked, submodules } = summarizeWorktreeChanges(entries)

    expect(staged + unstaged + untracked + submodules).toBe(total)
  })
})
