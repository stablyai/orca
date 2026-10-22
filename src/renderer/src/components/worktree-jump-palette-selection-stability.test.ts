// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { useMemo } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { createWorktreePaletteRequestGuard } from '@/lib/worktree-palette-create-action'
import { encodePaletteIdentity } from '@/lib/palette-match/palette-ranking'
import { useWorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'
import { makeRepo, makeWorktree } from './worktree-jump-palette-test-fixtures'

vi.mock('@/hooks/useSettingsNavigationMetadata', () => ({
  useSettingsNavigationMetadata: () => []
}))

const initialState = useAppStore.getInitialState()

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

it('keeps the recovered first row selected through subsequent membership changes', async () => {
  const worktrees = ['alpha', 'beta', 'gamma'].map((id) => makeWorktree(id, `refresh ${id}`))
  useAppStore.setState({
    activeModal: 'worktree-palette',
    repos: [makeRepo()],
    worktreesByRepo: { 'repo-1': worktrees },
    showSleepingWorkspaces: true,
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false
  })
  const { result } = renderHook(() => {
    const createLookupGuard = useMemo(() => createWorktreePaletteRequestGuard(), [])
    return useWorktreeJumpPaletteController({ visible: true, lingering: true, createLookupGuard })
  })
  await act(async () => result.current.handleQueryChange('refresh'))
  const selected = encodePaletteIdentity(['worktree', '|beta'])
  const survivor = encodePaletteIdentity(['worktree', '|alpha'])
  act(() => {
    result.current.selectionMovedByUserRef.current = true
    result.current.handleCommandSelectionChange(selected)
  })
  expect(result.current.commandSelectedItemId).toBe(selected)

  act(() => useAppStore.setState({ worktreesByRepo: { 'repo-1': [worktrees[0], worktrees[2]] } }))
  expect(result.current.commandSelectedItemId).toBe(survivor)

  act(() =>
    useAppStore.setState({
      worktreesByRepo: {
        'repo-1': [worktrees[0], worktrees[2], makeWorktree('delta', 'refresh delta')]
      }
    })
  )
  expect(result.current.commandSelectedItemId).toBe(survivor)
})
