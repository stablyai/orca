// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { useWorktreeRuntimeTarget } from './use-worktree-runtime-target'

const initialState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialState, true)
})

describe('worktree runtime target hook', () => {
  it('keeps the target identity stable across unrelated store writes', () => {
    const view = renderHook(() => useWorktreeRuntimeTarget(null))
    const initialTarget = view.result.current

    act(() => {
      useAppStore.setState({ agentStatusEpoch: useAppStore.getState().agentStatusEpoch + 1 })
    })

    expect(initialTarget).toEqual({ kind: 'local' })
    expect(view.result.current).toBe(initialTarget)
    view.unmount()
  })
})
