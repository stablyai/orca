import { createHostSessionLaunchRuntimeFixture } from './remote-runtime-host-session-launch-test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { deliverCreatedWebRuntimeAgentSessionPrompt } from '@/runtime/hosted-terminals/creation/web-runtime-created-agent-prompt-delivery'
const promptFailure = vi.hoisted(() => ({ error: vi.fn(), copy: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: promptFailure.error } }))
const delivery = vi.hoisted(() =>
  vi.fn<typeof deliverCreatedWebRuntimeAgentSessionPrompt>(async () => true)
)
vi.mock('@/runtime/hosted-terminals/creation/web-runtime-created-agent-prompt-delivery', () => ({
  deliverCreatedWebRuntimeAgentSessionPrompt: delivery
}))
const appStore = vi.hoisted(() => {
  const state = {
    runtimeStatusByEnvironmentId: new Map()
  }
  return { getState: vi.fn(() => state) }
})
vi.mock('@/runtime/web-session-tabs-sync/inventory/web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: vi.fn(async () => undefined)
}))

vi.mock('@/store/index', () => ({ useAppStore: { getState: appStore.getState } }))

describe('createRemoteRuntimePtyTransport Claude account', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  const fixture = createHostSessionLaunchRuntimeFixture()
  const { runtimeCall, runtimeSubscribe } = fixture

  beforeEach(() => {
    vi.resetModules()
    delivery.mockReset().mockResolvedValue(true)
    promptFailure.error.mockClear()
    promptFailure.copy.mockClear()
    fixture.reset()
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        runtimeEnvironments: {
          ...originalWindow?.api?.runtimeEnvironments,
          call: runtimeCall,
          subscribe: runtimeSubscribe
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  async function connectClaudeLaunch(options: {
    hostCapabilities: string[]
    resume?: boolean
    claudeAccountId: string
  }) {
    const created = {
      terminal: {
        handle: 'term-remote',
        worktreeId: 'repo1::/remote/wt',
        title: null,
        surface: 'background'
      }
    }
    runtimeCall.mockImplementation(async (args: { method?: string }) => ({
      id: 'rpc',
      ok: true,
      result:
        args.method === 'status.get'
          ? {
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: ['agent-session.host-authority.v1', ...options.hostCapabilities]
            }
          : created,
      _meta: { runtimeId: 'runtime-remote' }
    }))
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'repo1::/remote/wt',
      command: 'claude',
      launchAgent: 'claude',
      launchConfig: { agentArgs: '', agentEnv: {}, claudeAccountId: options.claudeAccountId },
      ...(options.resume
        ? { resumeProviderSession: { key: 'session_id' as const, id: 'provider-session' } }
        : {}),
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111'
    })
    await transport.connect({ url: '', callbacks: {} })
  }

  it.each([
    ['terminal.createAgentSession', false, '__active__'],
    ['terminal.ensureAgentSession', true, 'acct-b']
  ])(
    'sends the launch config Claude account on %s to a host that advertises it',
    async (method, resume, claudeAccountId) => {
      await connectClaudeLaunch({
        hostCapabilities: ['agent-session.claude-account.v1'],
        resume,
        claudeAccountId
      })

      expect(runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({ method, params: expect.objectContaining({ claudeAccountId }) })
      )
    }
  )

  it('omits the Claude account for a host whose strict agent-session params predate it', async () => {
    await connectClaudeLaunch({ hostCapabilities: [], claudeAccountId: '__active__' })

    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.createAgentSession',
        params: expect.not.objectContaining({ claudeAccountId: expect.anything() })
      })
    )
  })
})
