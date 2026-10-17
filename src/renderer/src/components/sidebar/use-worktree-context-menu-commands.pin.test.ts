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
  it('qualifies the write by the row host when the row names one', () => {
    const write = togglePinFromMenu({ id: 'repo::/feature', isPinned: false, hostId: 'ssh:build' })

    expect(write).toHaveBeenCalledWith(
      [{ worktreeId: 'repo::/feature', executionHostId: 'ssh:build' }],
      true
    )
  })

  it('keeps the bare-id lookup for a row without a host', () => {
    const write = togglePinFromMenu({ id: 'repo::/feature', isPinned: true })

    expect(write).toHaveBeenCalledWith(['repo::/feature'], false)
  })
})
