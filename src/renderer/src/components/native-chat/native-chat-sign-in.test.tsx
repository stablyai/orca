// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useNativeChatSignIn } from './native-chat-sign-in'

const { state, remoteCreate, persistOrder, startHost, notifyFailure } = vi.hoisted(() => ({
  state: {
    settings: null,
    createTab: vi.fn(() => ({ id: 'login-terminal' })),
    setActiveTabType: vi.fn()
  },
  remoteCreate: vi.fn(
    async (): Promise<{ status: 'created' } | { status: 'failed'; message: string }> => ({
      status: 'created'
    })
  ),
  persistOrder: vi.fn(),
  startHost: vi.fn(async () => true),
  notifyFailure: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(<T,>(selector: (s: typeof state) => T) => selector(state), {
    getState: () => state
  })
}))
vi.mock('@/lib/agent-session/launch/pane/launch-agent-tab-order', () => ({
  persistAgentLaunchTabOrder: persistOrder
}))
vi.mock('@/runtime/hosted-terminals/creation/web-runtime-terminal-creation', () => ({
  createWebRuntimeSessionTerminalOnHost: remoteCreate
}))
vi.mock('@/runtime/hosted-terminals/creation/web-runtime-terminal-create-failure-notice', () => ({
  notifyWebRuntimeTerminalCreateFailure: notifyFailure
}))
vi.mock('@/lib/wsl-host-user-start', () => ({ startStoppedWslHostForUserAct: startHost }))
vi.mock('@/lib/claude-account-sign-in', () => ({ signInToClaudeAccount: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('runs sign-in on the paired chat host instead of making a local terminal', async () => {
  const { result } = renderHook(() =>
    useNativeChatSignIn({
      agent: 'pi',
      target: { kind: 'environment', environmentId: 'paired-host' },
      worktreeId: 'remote-project',
      groupId: 'remote-pane',
      failure: null,
      startFailures: []
    })
  )
  act(() => {
    result.current?.signIn()
    result.current?.signIn()
  })
  await waitFor(() => expect(result.current?.signingIn).toBe(false))
  expect(remoteCreate).toHaveBeenCalledExactlyOnceWith(
    {
      worktreeId: 'remote-project',
      environmentId: 'paired-host',
      targetGroupId: 'remote-pane',
      command: 'pi',
      viewMode: 'terminal',
      activate: true
    },
    { notifyFailure: false }
  )
  expect(state.createTab).not.toHaveBeenCalled()
})

it('reports a returned host failure once and permits a later user retry', async () => {
  remoteCreate.mockResolvedValueOnce({ status: 'failed', message: 'Host disconnected' })
  const { result } = renderHook(() =>
    useNativeChatSignIn({
      agent: 'pi',
      target: { kind: 'environment', environmentId: 'paired-host' },
      worktreeId: 'remote-project',
      failure: null,
      startFailures: []
    })
  )
  act(() => result.current?.signIn())
  await waitFor(() => expect(result.current?.signingIn).toBe(false))
  expect(notifyFailure).toHaveBeenCalledExactlyOnceWith('Host disconnected', {
    environmentId: 'paired-host',
    worktreeId: 'remote-project'
  })
  act(() => result.current?.signIn())
  await waitFor(() => expect(remoteCreate).toHaveBeenCalledTimes(2))
  expect(notifyFailure).toHaveBeenCalledOnce()
})

it('leaves a failed WSL start to its existing notification owner', async () => {
  startHost.mockResolvedValueOnce(false)
  const { result } = renderHook(() =>
    useNativeChatSignIn({
      agent: 'omp',
      target: { kind: 'environment', environmentId: 'wsl-host' },
      worktreeId: 'remote-project',
      failure: null,
      startFailures: []
    })
  )
  act(() => result.current?.signIn())
  await waitFor(() => expect(result.current?.signingIn).toBe(false))
  expect(remoteCreate).not.toHaveBeenCalled()
  expect(notifyFailure).not.toHaveBeenCalled()
})
