// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNativeChatHostSetup } from './native-chat-host-setup'

const { state, remoteCreate, persistOrder, startHost, notifyFailure, managedSignIn } = vi.hoisted(
  () => {
    const settings: { activeClaudeManagedAccountId: string | null } = {
      activeClaudeManagedAccountId: null
    }
    return {
      state: {
        settings,
        runtimeStatusByEnvironmentId: new Map([
          ['paired-host', { status: { hostPlatform: 'linux' } }]
        ]),
        createTab: vi.fn(() => ({ id: 'login-terminal' })),
        setActiveTabType: vi.fn(),
        runtimeDetectedAgentIds: {},
        runtimeAgentDetectionNeedsServerUpdate: {},
        runtimeAgentInventoryOutcome: vi.fn<() => 'successful' | 'failed'>(() => 'successful'),
        refreshRuntimeDetectedAgents: vi.fn(async () => ['codex'])
      },
      remoteCreate: vi.fn(
        async (): Promise<{ status: 'created' } | { status: 'failed'; message: string }> => ({
          status: 'created'
        })
      ),
      persistOrder: vi.fn(),
      startHost: vi.fn(async () => true),
      notifyFailure: vi.fn(),
      managedSignIn: vi.fn(async () => true)
    }
  }
)
vi.mock('@/store/index', () => ({
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
vi.mock('@/runtime/hosts/wsl/wsl-host-user-start', () => ({
  startStoppedWslHostForUserAct: startHost
}))
vi.mock('@/lib/provider-accounts/claude-account-sign-in', () => ({
  signInToClaudeAccount: managedSignIn
}))
vi.mock('@/app-shell/platform/renderer-app-platform', () => ({
  getRendererAppPlatform: () => 'linux'
}))

beforeEach(() => {
  state.settings.activeClaudeManagedAccountId = null
  state.runtimeAgentInventoryOutcome.mockReturnValue('successful')
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('suppresses all sign-in actions after managed sign-in succeeds until a new failure', async () => {
  state.settings = { activeClaudeManagedAccountId: 'managed-account' }
  const { result, rerender } = renderHook(
    ({ failure }) =>
      useNativeChatHostSetup({
        agent: 'claude',
        target: { kind: 'local' },
        worktreeId: 'project',
        account: 'managed',
        failure,
        startFailures: [],
        onRechecked: vi.fn()
      }),
    { initialProps: { failure: { kind: 'notSignedIn' } } }
  )
  expect(result.current.signIn?.signingIn).toBe(false)
  await act(async () => result.current.signIn?.signIn())
  expect(result.current.signIn).toBeNull()
  rerender({ failure: { kind: 'notSignedIn' } })
  expect(result.current.signIn?.signingIn).toBe(false)
})

function renderRemoteSetup() {
  return renderHook(() =>
    useNativeChatHostSetup({
      agent: 'codex',
      target: { kind: 'environment', environmentId: 'paired-host' },
      worktreeId: 'remote-project',
      groupId: 'remote-pane',
      account: undefined,
      failure: null,
      startFailures: [],
      onRechecked: vi.fn()
    })
  )
}

it.each([
  [
    'terminal creation fails',
    () => remoteCreate.mockResolvedValueOnce({ status: 'failed', message: 'Host disconnected' })
  ],
  ['host startup is cancelled', () => startHost.mockResolvedValueOnce(false)]
])('keeps installation retryable when %s', async (_case, fail) => {
  fail()
  const { result } = renderRemoteSetup()
  act(() => result.current.install?.run())
  await waitFor(() => expect(result.current.install?.busy).toBe(false))
  expect(result.current.install?.phase).toBe('install')
  act(() => result.current.install?.run())
  await waitFor(() => expect(result.current.install?.phase).toBe('recheck'))
})

it('waits for terminal creation before advancing installation', async () => {
  let finish!: (value: { status: 'created' }) => void
  remoteCreate.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const { result } = renderRemoteSetup()
  act(() => result.current.install?.run())
  expect(result.current.install?.busy).toBe(true)
  expect(result.current.install?.phase).toBe('install')
  await act(async () => finish({ status: 'created' }))
  expect(result.current.install?.busy).toBe(false)
  expect(result.current.install?.phase).toBe('recheck')
})

it('retries the check after a refresh resolves with stale inventory from a failed probe', async () => {
  const { result } = renderRemoteSetup()
  await act(async () => result.current.install?.run())
  expect(result.current.install?.phase).toBe('recheck')

  state.runtimeAgentInventoryOutcome.mockReturnValue('failed')
  await act(async () => result.current.install?.run())
  expect(result.current.install?.busy).toBe(false)
  expect(result.current.install?.phase).toBe('recheck')

  state.runtimeAgentInventoryOutcome.mockReturnValue('successful')
  await act(async () => result.current.install?.run())
  expect(result.current.install?.phase).toBe('install')
})

it('keeps the check available after a rejected refresh', async () => {
  const { result } = renderRemoteSetup()
  await act(async () => result.current.install?.run())
  state.refreshRuntimeDetectedAgents.mockRejectedValueOnce(new Error('Host disconnected'))
  await act(async () => result.current.install?.run())
  expect(result.current.install?.busy).toBe(false)
  expect(result.current.install?.phase).toBe('recheck')
})
