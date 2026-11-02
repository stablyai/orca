// @vitest-environment happy-dom
import { act, renderHook, cleanup } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { useQuickOpenInteraction } from './use-quick-open-interaction'
const initial = useAppStore.getInitialState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})
it('revokes dismissal/reopen and workspace-switch/return even without an intervening render', () => {
  useAppStore.setState({ activeModal: 'quick-open', activeWorktreeId: 'wt' })
  const hook = renderHook(() => useQuickOpenInteraction('wt'))
  let request: ReturnType<typeof hook.result.current.begin> | undefined
  act(() => {
    request = hook.result.current.begin()
  })
  expect(request?.isCurrent()).toBe(true)
  act(() => {
    useAppStore.setState({ activeModal: 'add-repo' })
    useAppStore.setState({ activeModal: 'quick-open' })
  })
  expect(request?.isCurrent()).toBe(false)
  act(() => {
    request = hook.result.current.begin()
  })
  act(() => {
    useAppStore.setState({ activeWorktreeId: 'another' })
    useAppStore.setState({ activeWorktreeId: 'wt' })
  })
  expect(request?.isCurrent()).toBe(false)
  act(() => {
    request = hook.result.current.begin()
  })
  act(() => {
    useAppStore.setState({ activeWorkspaceExecutionHostId: 'ssh:other' })
    useAppStore.setState({ activeWorkspaceExecutionHostId: 'local' })
  })
  expect(request?.isCurrent()).toBe(false)
  expect(hook.result.current.opening).toBe(false)
  act(() => {
    request = hook.result.current.begin()
  })
  hook.unmount()
  expect(request?.isCurrent()).toBe(false)
})
