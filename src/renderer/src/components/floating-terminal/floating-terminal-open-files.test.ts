import { describe, expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { getFloatingTerminalOpenFiles } from './floating-terminal-open-files'

const file = (id: string, worktreeId: string): OpenFile =>
  ({
    id,
    filePath: `/tmp/${id}.md`,
    relativePath: `${id}.md`,
    worktreeId,
    language: 'markdown',
    content: '',
    isDirty: false,
    isPinned: false,
    mode: 'edit',
    mtime: 0,
    runtimeEnvironmentId: null
  }) as OpenFile

describe('getFloatingTerminalOpenFiles', () => {
  it('preserves the filtered array when unrelated worktree files change', () => {
    const floating = file('floating', FLOATING_TERMINAL_WORKTREE_ID)
    const first = getFloatingTerminalOpenFiles([floating, file('main-a', 'wt-1')])
    const second = getFloatingTerminalOpenFiles([floating, file('main-b', 'wt-2')])

    expect(second).toBe(first)
    expect(second).toEqual([floating])
  })

  it('updates the filtered array when a floating file changes', () => {
    const first = getFloatingTerminalOpenFiles([file('floating-a', FLOATING_TERMINAL_WORKTREE_ID)])
    const second = getFloatingTerminalOpenFiles([file('floating-b', FLOATING_TERMINAL_WORKTREE_ID)])

    expect(second).not.toBe(first)
    expect(second.map((item) => item.id)).toEqual(['floating-b'])
  })
})
