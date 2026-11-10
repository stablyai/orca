import type * as CreateRequest from '@/runtime/hosted-terminals/creation/agent-launch/agent-session-create-request'
import type * as HostSettings from '@/runtime/agent-launch-settings/agent-launch-settings-transport'
// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type { createWebRuntimeSessionTerminalResult } from '@/runtime/hosted-terminals/creation/web-runtime-terminal-create-operation'
import type { readHostAgentStartupSettings } from '@/runtime/agent-launch-settings/agent-launch-settings-transport'
import { launchAgentInWebHostTab } from '@/lib/agent-session/launch/new-tab/launch-agent-web-host-tab'

const mocks = vi.hoisted(() => ({
  create: vi.fn<typeof createWebRuntimeSessionTerminalResult>(),
  settings: vi.fn<typeof readHostAgentStartupSettings>(),
  paste: vi.fn(async () => true),
  error: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      runtimeStatusByEnvironmentId: new Map(),
      setActiveTabType: vi.fn(),
      seedNativeChatLaunchDraft: vi.fn(),
      seedNativeChatLaunchPrompt: vi.fn(),
      markNativeChatLaunchPromptFailed: vi.fn()
    })
  }
}))
vi.mock('sonner', () => ({ toast: { error: mocks.error } }))
vi.mock(
  '@/runtime/hosted-terminals/creation/agent-launch/agent-session-create-request',
  async (original) => ({
    ...(await original<typeof CreateRequest>()),
    agentSessionCreateCapabilities: async () => ({ capable: false, complete: false })
  })
)
vi.mock('@/runtime/agent-launch-settings/agent-launch-settings-transport', async (original) => ({
  ...(await original<typeof HostSettings>()),
  readHostAgentStartupSettings: mocks.settings
}))
vi.mock('@/runtime/hosted-terminals/creation/web-runtime-terminal-create-operation', () => ({
  createWebRuntimeSessionTerminalResult: mocks.create
}))
vi.mock('@/lib/agent-session/messaging/paste/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mocks.paste
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.create.mockResolvedValue({ outcome: { status: 'created' }, hostTabId: 'actual-host-tab' })
})

it('cancels after asynchronous compatibility preparation without dispatching or reporting failure', async () => {
  const settings = Promise.withResolvers<Awaited<ReturnType<typeof readHostAgentStartupSettings>>>()
  mocks.settings.mockReturnValue(settings.promise)
  const dispatch = vi.fn()
  mocks.create.mockImplementation(async (args) => {
    try {
      const prepared = await args.legacyAgentLaunch?.()
      dispatch(prepared)
      return { outcome: { status: 'created' }, hostTabId: 'unexpected' }
    } catch {
      return { outcome: { status: 'failed', message: 'cancelled' } }
    }
  })
  let cancelled = false
  const launch = launchAgentInWebHostTab({
    agent: 'goose',
    worktreeId: 'wt',
    environmentId: 'host',
    prompt: 'held message',
    promptDelivery: 'draft',
    sessionOptions: { permissionMode: 'full-access' },
    isCancelled: () => cancelled,
    buildStartup: () => {
      throw new Error('cancelled preparation must stop')
    }
  })
  await vi.waitFor(() => expect(mocks.settings).toHaveBeenCalledOnce())
  cancelled = true
  settings.resolve({ agentCmdOverrides: {}, agentDefaultArgs: {} })
  await expect(launch).resolves.toMatchObject({ delivered: false, failureNotified: false })
  expect(dispatch).not.toHaveBeenCalled()
  expect(mocks.paste).not.toHaveBeenCalled()
  expect(mocks.error).not.toHaveBeenCalled()
})
