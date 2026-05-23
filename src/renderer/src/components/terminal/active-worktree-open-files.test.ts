import { describe, expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { getActiveWorktreeOpenFiles } from './active-worktree-open-files'

const file = (id: string, worktreeId: string): OpenFile =>
  ({
    id,
    filePath: `/tmp/${id}.md`,
    relativePath: `${id}.md`,
    worktreeId,
    language: 'markdown',
    isDirty: false,
    runtimeEnvironmentId: null
  }) as OpenFile

describe('getActiveWorktreeOpenFiles', () => {
  it('preserves the active slice when unrelated worktree files change', () => {
    const active = file('active', 'wt-active')
    const first = getActiveWorktreeOpenFiles([active, file('other-a', 'wt-other')], 'wt-active')
    const second = getActiveWorktreeOpenFiles([active, file('other-b', 'wt-other')], 'wt-active')

    expect(second).toBe(first)
    expect(second).toEqual([active])
  })

  it('updates the active slice when an active file changes', () => {
    const first = getActiveWorktreeOpenFiles([file('active-a', 'wt-active')], 'wt-active')
    const second = getActiveWorktreeOpenFiles([file('active-b', 'wt-active')], 'wt-active')

    expect(second).not.toBe(first)
    expect(second.map((item) => item.id)).toEqual(['active-b'])
  })

  it('returns a stable empty slice without an active worktree', () => {
    const first = getActiveWorktreeOpenFiles([file('active', 'wt-active')], null)
    const second = getActiveWorktreeOpenFiles([file('other', 'wt-other')], null)

    expect(second).toBe(first)
    expect(second).toEqual([])
  })
})
