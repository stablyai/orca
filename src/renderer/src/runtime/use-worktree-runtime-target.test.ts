// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { useWorktreeRuntimeTarget } from './use-worktree-runtime-target'

const initialState = useAppStore.getInitialState()

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

it('keeps the runtime target identity stable across unrelated store writes', () => {
  let renders = 0
  const { result } = renderHook(() => {
    renders += 1
    return useWorktreeRuntimeTarget('worktree-1')
  })

  const first = result.current
  const rendersAfterMount = renders

  act(() => {
    for (let index = 0; index < 50; index += 1) {
      useAppStore.setState({ activeRepoId: `repo-${index}` })
    }
  })

  // A selector that built the target object inline re-rendered on every write.
  expect(renders).toBe(rendersAfterMount)
  expect(result.current).toBe(first)
})
