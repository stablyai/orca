// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const { state, remoteCreate, persistOrder } = vi.hoisted(() => ({
  state: {
    settings: null,
    createTab: vi.fn(() => ({ id: 'login-terminal' })),
    setActiveTabType: vi.fn()
  },
  remoteCreate: vi.fn(async () => ({ status: 'created' })),
  persistOrder: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(<T,>(selector: (s: typeof state) => T) => selector(state), {
    getState: () => state
  })
}))
vi.mock('@/lib/launch-agent-tab-order', () => ({ persistAgentLaunchTabOrder: persistOrder }))
vi.mock('@/runtime/web-runtime-terminal-creation', () => ({
  createWebRuntimeSessionTerminal: remoteCreate
}))
vi.mock('@/lib/claude-account-sign-in', () => ({ signInToClaudeAccount: vi.fn() }))
import { useNativeChatSignIn } from './native-chat-sign-in'

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
    { userAct: true }
  )
  expect(state.createTab).not.toHaveBeenCalled()
})
