// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings, FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { useFileExplorerDragDrop } from './useFileExplorerDragDrop'

const { confirmMock, executeOpenEditorPathMoveMock } = vi.hoisted(() => ({
  confirmMock: vi.fn(),
  executeOpenEditorPathMoveMock: vi.fn()
}))

vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => confirmMock
}))

vi.mock('@/lib/execute-open-editor-path-move', () => ({
  executeOpenEditorPathMove: executeOpenEditorPathMoveMock
}))

describe('useFileExplorerDragDrop move confirmation', () => {
  beforeEach(() => {
    confirmMock.mockReset().mockResolvedValue(true)
    executeOpenEditorPathMoveMock.mockReset().mockResolvedValue(undefined)
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/tmp'),
        confirmFileExplorerMove: 'directories'
      }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('prompts for a selected directory even when the primary dragged row is a file', async () => {
    const refreshDir = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() =>
      useFileExplorerDragDrop({
        worktreePath: '/repo',
        activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        expanded: new Set(),
        toggleDir: vi.fn(),
        refreshDir,
        scrollRef: { current: null },
        getOperationOwnerForPath: () => ({ kind: 'local' })
      })
    )

    act(() => {
      result.current.setDragSourcePath('/repo/src/index.ts', false, [
        ['/repo/src/index.ts', false],
        ['/repo/src/components', true]
      ])
      result.current.handleMoveDrop('/repo/src/components', '/repo/dest')
    })

    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1))
    expect(executeOpenEditorPathMoveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        fromPath: '/repo/src/components',
        toPath: '/repo/dest/components'
      })
    )
  })
})
