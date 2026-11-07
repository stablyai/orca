// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

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
vi.mock('@/runtime/web-runtime-terminal-creation', () => ({
  createWebRuntimeSessionTerminalOnHost: remoteCreate
}))
vi.mock('@/runtime/web-runtime-terminal-create-failure-notice', () => ({
  notifyWebRuntimeTerminalCreateFailure: notifyFailure
}))
vi.mock('@/lib/wsl-host-user-start', () => ({ startStoppedWslHostForUserAct: startHost }))
vi.mock('@/lib/claude-account-sign-in', () => ({ signInToClaudeAccount: vi.fn() }))
import { NativeChatSignInContext, useNativeChatSignIn } from './native-chat-sign-in'
import { NativeChatSignInButton } from './NativeChatSignInButton'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it.each([
  ['opencode', 'opencode auth login'],
  ['pi', 'pi'],
  ['omp', 'omp']
])(
  'opens %s sign-in as a plain terminal in the originating folder and pane',
  async (agent, command) => {
    const { result } = renderHook(() =>
      useNativeChatSignIn({
        agent,
        target: { kind: 'local' },
        worktreeId: 'folder:login-project',
        groupId: 'chat-pane',
        failure: null,
        startFailures: []
      })
    )
    act(() => result.current?.signIn())
    await waitFor(() => expect(result.current?.signingIn).toBe(false))
    expect(state.createTab).toHaveBeenCalledExactlyOnceWith(
      'folder:login-project',
      'chat-pane',
      undefined,
      { pendingStartup: { command }, viewMode: 'terminal' }
    )
    expect(state.setActiveTabType).toHaveBeenCalledWith('terminal', 'folder:login-project')
    expect(persistOrder).toHaveBeenCalledWith('folder:login-project', 'login-terminal')
    expect(remoteCreate).not.toHaveBeenCalled()
  }
)

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

it.each([20, 200])('shares one sign-in operation across %i row actions', async (count) => {
  const pending = Promise.withResolvers<{ status: 'created' }>()
  remoteCreate.mockReturnValueOnce(pending.promise)
  const eligibleRender = vi.fn()
  const unrelatedRender = vi.fn()
  const rows = Array.from({ length: count }, (_, index) => (
    <div key={index}>
      <Profiler id={`auth-${index}`} onRender={eligibleRender}>
        <NativeChatSignInButton failureKind="notSignedIn" />
      </Profiler>
      <Profiler id={`other-${index}`} onRender={unrelatedRender}>
        <NativeChatSignInButton failureKind="providerRejected" />
      </Profiler>
    </div>
  ))
  function Chat({ revision: _revision }: { revision: number }) {
    const signIn = useNativeChatSignIn({
      agent: 'pi',
      target: { kind: 'environment', environmentId: 'paired-host' },
      worktreeId: 'remote-project',
      failure: null,
      startFailures: []
    })
    return (
      <NativeChatSignInContext.Provider value={signIn}>{rows}</NativeChatSignInContext.Provider>
    )
  }
  const view = render(<Chat revision={0} />)
  eligibleRender.mockClear()
  unrelatedRender.mockClear()
  await act(async () => view.rerender(<Chat revision={1} />))
  expect(eligibleRender).not.toHaveBeenCalled()
  expect(unrelatedRender).not.toHaveBeenCalled()
  expect(remoteCreate).not.toHaveBeenCalled()
  expect(state.createTab).not.toHaveBeenCalled()
  const buttons = view.getAllByRole('button')
  expect(buttons).toHaveLength(count)
  await act(async () => {
    for (const button of buttons) {
      fireEvent.click(button)
    }
  })
  expect(startHost).toHaveBeenCalledOnce()
  expect(remoteCreate).toHaveBeenCalledOnce()
  expect(unrelatedRender).not.toHaveBeenCalled()
  expect(eligibleRender).toHaveBeenCalledTimes(count)
  expect(buttons.every((button) => button instanceof HTMLButtonElement && button.disabled)).toBe(
    true
  )
  eligibleRender.mockClear()
  await act(async () => pending.resolve({ status: 'created' }))
  expect(eligibleRender).toHaveBeenCalledTimes(count)
  expect(unrelatedRender).not.toHaveBeenCalled()
  expect(buttons.every((button) => button instanceof HTMLButtonElement && !button.disabled)).toBe(
    true
  )
  expect(remoteCreate).toHaveBeenCalledOnce()
})
