// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PendingParentPicker } from './use-worktree-parent-picker-transition'
import { useWorktreeParentPickerTransition } from './use-worktree-parent-picker-transition'
import { captureFolderParentContext } from './folder-workspace-parent-candidates'
import { makeWorktree } from '../worktree-jump-palette-test-fixtures'
import { createWorktreeIdentity } from '../../../../shared/worktree/identity'

function setup() {
  const anchor = document.createElement('div')
  document.body.append(anchor)
  const id = 'repo::/child'
  const child = makeWorktree(id, 'Child', {
    hostId: 'runtime:owner',
    runtimeOwnerEnvironmentId: 'owner',
    instanceId: 'instance',
    identity: createWorktreeIdentity({
      worktreeId: id,
      executionHostId: 'local',
      instanceId: 'instance'
    })
  })
  const captured = captureFolderParentContext({}, child)
  const pendingRef: { current: PendingParentPicker | null } = { current: null }
  const setParentPicker = vi.fn()
  const setParentPickerOpen = vi.fn()
  const setMenuOpenState = vi.fn()
  const fallbackTimerRef: { current: number | null } = { current: null }
  const unmountTimerRef: { current: number | null } = { current: null }
  const hook = renderHook(
    ({ worktreeId }) =>
      useWorktreeParentPickerTransition({
        worktreeId,
        pendingRef,
        fallbackTimerRef,
        unmountTimerRef,
        scopeRef: { current: anchor },
        setParentPicker,
        setParentPickerOpen,
        setMenuOpenState,
        captureFolderContext: () => captured
      }),
    { initialProps: { worktreeId: id } }
  )
  return { hook, captured, pendingRef, setParentPicker, setParentPickerOpen, setMenuOpenState }
}

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.useRealTimers()
})

describe('parent picker transition', () => {
  it('retains the captured child and runtime after active row props change', () => {
    vi.useFakeTimers()
    const fixture = setup()
    act(() => fixture.hook.result.current.handleOpenFolderParentPicker())
    expect(fixture.pendingRef.current?.folderContext).toEqual(fixture.captured)
    fixture.hook.rerender({ worktreeId: 'other-host::/other' })
    act(() => vi.advanceTimersByTime(50))
    expect(fixture.setParentPicker).toHaveBeenCalledWith(
      expect.objectContaining({
        childWorktreeId: 'repo::/child',
        folderContext: fixture.captured
      })
    )
    expect(fixture.setParentPickerOpen).toHaveBeenCalledWith(true)
    expect(fixture.setMenuOpenState).toHaveBeenCalledWith(false)
  })
  it('keeps the existing Git-only transition free of folder mode', () => {
    vi.useFakeTimers()
    const fixture = setup()
    act(() => fixture.hook.result.current.handleOpenParentPicker())
    expect(fixture.pendingRef.current).not.toHaveProperty('folderContext')
  })
})
