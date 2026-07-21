// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useAppStore } from '../../store'
import { usePetAgentAsk } from './pet-agent-ask'
import { setPetBoundSession } from './pet-bound-session'

/**
 * Regression cover for React error #185 (maximum update depth exceeded) on
 * clicking "Give me an assistant".
 *
 * The bug: usePetAgentAsk selected `resolvePetBoundNoteTarget(...)` straight out
 * of useAppStore. That selector builds a fresh object every call, so zustand's
 * Object.is equality re-rendered forever the moment a bound session existed —
 * which is exactly what a successful spawn creates. It was invisible until then
 * because with no binding the selector returned a stable null.
 *
 * This mounts the hook WITH a bound session whose tab is present in the store,
 * the post-spawn state. If the selector ever returns an unstable derived object
 * again, renderHook throws the same "Maximum update depth exceeded".
 */

const LEAF = 'ed140e4c-337a-4ac6-b034-7bcb9cdccca7'

afterEach(() => {
  setPetBoundSession(null)
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('usePetAgentAsk (render stability)', () => {
  it('does not loop when a bound session resolves to a real tab', () => {
    // Cast through unknown: the test only needs the two fields
    // resolvePetBoundNoteTarget reads (activeLeafId, tab id), not full
    // TerminalLayout/TerminalTab shapes.
    useAppStore.setState({
      terminalLayoutsByTabId: { 'tab-1': { activeLeafId: LEAF } },
      tabsByWorktree: { 'repo::/w': [{ id: 'tab-1' }] }
    } as unknown as Partial<ReturnType<typeof useAppStore.getState>>)
    setPetBoundSession({ tabId: 'tab-1', worktreeId: 'repo::/w' })

    const { result } = renderHook(() => usePetAgentAsk(null))

    // Reaching here at all proves no infinite loop; the value proves the bound
    // session actually drove `canAsk`, not a coincidental null.
    expect(result.current.canAsk).toBe(true)
  })
})
