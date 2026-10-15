/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { Worktree } from '../../../../shared/worktree/types'
import { useWorktreeContextMenuCommands } from './use-worktree-context-menu-commands'

type CommandArgs = Parameters<typeof useWorktreeContextMenuCommands>[0]

function togglePinFromMenu(row: Pick<Worktree, 'id' | 'isPinned'> & { hostId?: string }) {
  const setWorktreesPinnedAndReveal = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: handleTogglePin reads only the row and the pin writer; the other fields are never touched here.
  const args = { worktree: row, setWorktreesPinnedAndReveal } as unknown as CommandArgs
  const { result } = renderHook(() => useWorktreeContextMenuCommands(args))
  result.current.handleTogglePin()
  return setWorktreesPinnedAndReveal
}

describe('context menu pin write', () => {
  it('passes the clicked row with its host', () => {
    const row = { id: 'repo::/feature', isPinned: false, hostId: 'ssh:build' }
    const write = togglePinFromMenu(row)

    expect(write).toHaveBeenCalledWith([row], true)
  })

  it('passes a row without a host as is, leaving twin resolution to the store', () => {
    const row = { id: 'repo::/feature', isPinned: true }
    const write = togglePinFromMenu(row)

    expect(write).toHaveBeenCalledWith([row], false)
  })
})
