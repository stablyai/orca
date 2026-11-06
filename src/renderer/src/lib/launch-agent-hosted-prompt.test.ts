import type * as CreateRequest from '@/runtime/agent-session-create-request'
import type * as HostSettings from '@/runtime/agent-launch-settings/agent-launch-settings-transport'
// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type { createWebRuntimeSessionTerminalResult } from '@/runtime/web-runtime-terminal-create-operation'
import type { readHostAgentStartupSettings } from '@/runtime/agent-launch-settings/agent-launch-settings-transport'
import { launchAgentInWebHostTab } from './launch-agent-web-host-tab'

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
vi.mock('@/runtime/agent-session-create-request', async (original) => ({
  ...(await original<typeof CreateRequest>()),
  agentSessionCreateCapabilities: async () => ({ capable: false, complete: false })
}))
vi.mock('@/runtime/agent-launch-settings/agent-launch-settings-transport', async (original) => ({
  ...(await original<typeof HostSettings>()),
  readHostAgentStartupSettings: mocks.settings
}))
vi.mock('@/runtime/web-runtime-terminal-create-operation', () => ({
  createWebRuntimeSessionTerminalResult: mocks.create
}))
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: mocks.paste }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.create.mockResolvedValue({ outcome: { status: 'created' }, hostTabId: 'actual-host-tab' })
})

it('keeps stdin auto-submit intent when normalizing an ordinary hosted fresh launch', async () => {
  const result = await launchAgentInWebHostTab({
    agent: 'aider',
    worktreeId: 'wt',
    environmentId: 'host',
    prompt: 'do the work',
    promptDelivery: 'auto-submit',
    submitFollowup: true,
    buildStartup: () => {
      throw new Error('host-composed launch must not compile desktop settings')
    }
  })
  expect(result.delivered).toBe(true)
  expect(mocks.create.mock.calls[0]?.[0]).not.toHaveProperty('prompt')
  expect(mocks.paste).toHaveBeenCalledWith(
    expect.objectContaining({
      tabId: 'web-terminal-actual-host-tab',
      content: 'do the work',
      submit: true,
      forcePaste: true
    })
  )
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

it('keeps the Codex submit marker on a clean hosted request', async () => {
  await launchAgentInWebHostTab({
    agent: 'codex',
    worktreeId: 'wt',
    environmentId: 'host',
    prompt: 'Fix checks',
    promptDelivery: 'submit-after-ready',
    buildStartup: () => {
      throw new Error('no desktop preparation')
    }
  })
  expect(mocks.create.mock.calls[0]?.[0]).toMatchObject({
    agent: 'codex',
    promptDelivery: 'auto-submit'
  })
  expect(mocks.create.mock.calls[0]?.[0]).not.toHaveProperty('prompt')
})

it('launches a Windows cmd multiline Claude draft cleanly and pastes the retained text', async () => {
  await launchAgentInWebHostTab({
    agent: 'claude',
    worktreeId: 'wt',
    environmentId: 'host',
    launchPlatform: 'win32',
    launchShell: 'cmd',
    prompt: 'first line\nsecond line',
    promptDelivery: 'draft',
    buildStartup: () => {
      throw new Error('no desktop preparation')
    }
  })
  expect(mocks.create.mock.calls[0]?.[0]).not.toHaveProperty('prompt')
  expect(mocks.create.mock.calls[0]?.[0]).not.toHaveProperty('promptDelivery')
  expect(mocks.paste).toHaveBeenCalledWith(
    expect.objectContaining({ content: 'first line\nsecond line', submit: false, forcePaste: true })
  )
})

it('keeps an ordinary hosted Amp prompt unsubmitted', async () => {
  await launchAgentInWebHostTab({
    agent: 'amp',
    worktreeId: 'wt',
    environmentId: 'host',
    prompt: 'Explain the failing check',
    promptDelivery: 'auto-submit',
    buildStartup: () => {
      throw new Error('no desktop preparation')
    }
  })
  expect(mocks.paste).toHaveBeenCalledWith(
    expect.objectContaining({ content: 'Explain the failing check', submit: false })
  )
})

it.each([undefined, true])(
  'reports one failed prompt attempt with creation followup=%s',
  async (submitFollowup) => {
    mocks.paste.mockResolvedValueOnce(false)
    const copy = vi.fn()
    Object.assign(window, { api: { ui: { writeClipboardText: copy } } })
    const result = await launchAgentInWebHostTab({
      agent: 'aider',
      worktreeId: 'wt',
      environmentId: 'host',
      prompt: 'fix the parser',
      promptDelivery: 'draft',
      submitFollowup,
      buildStartup: () => {
        throw new Error('no desktop preparation')
      }
    })
    expect(result).toMatchObject({ delivered: false, failureNotified: true })
    expect(mocks.paste).toHaveBeenCalledOnce()
    expect(mocks.error).toHaveBeenCalledOnce()
    if (submitFollowup) {
      mocks.error.mock.calls[0]?.[1].action.onClick()
      expect(copy).toHaveBeenCalledExactlyOnceWith('fix the parser')
    } else {
      expect(mocks.error.mock.calls[0]).toHaveLength(1)
    }
  }
)
