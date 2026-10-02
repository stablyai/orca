import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  receipt: vi.fn(),
  exited: vi.fn(),
  unconfirmed: vi.fn(),
  notDelivered: vi.fn()
}))

vi.mock('@/lib/agent-launch-prompt-receipt', () => ({ waitForLaunchPromptReceipt: mocks.receipt }))
vi.mock('@/lib/agent-launch-prompt-not-delivered-notice', () => ({
  showAgentLaunchExitedNotice: mocks.exited,
  showAgentLaunchPromptUnconfirmedNotice: mocks.unconfirmed,
  showAgentLaunchPromptNotDeliveredNotice: mocks.notDelivered
}))
vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: vi.fn(),
  seedNativeChatLaunchDraftForAgentTab: vi.fn(),
  seedNativeChatLaunchPromptForAgentTab: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-1' }] } })
  }
}))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn(), tuiAgentToAgentKind: vi.fn() }))

import { deliverNewTabLaunchPrompt } from './launch-agent-new-tab-prompt-delivery'

function deliver(promptDelivery: 'submit-after-ready' | 'auto-submit' = 'submit-after-ready') {
  return deliverNewTabLaunchPrompt({
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    agent: 'claude',
    prompt: 'fix the failing checks',
    promptDelivery,
    pasteDraftAfterLaunch: null,
    submitPastedPrompt: false,
    promptInLaunchFile: false,
    launchedAt: 0
  })
}

// Why: the notice must say what happened (stack QA 1.3); "the agent started, but your prompt
// wasn't sent" was shown for an agent that crashed with the prompt already on its command line.
describe('the notice for a prompt the launch line carried', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('says the agent exited at startup when it quit before reading the prompt', async () => {
    mocks.receipt.mockResolvedValue('agent-exited')
    await expect(deliver()).resolves.toEqual({ delivered: false, failureNotified: true })
    expect(mocks.exited).toHaveBeenCalledWith({
      agent: 'claude',
      prompt: 'fix the failing checks'
    })
    expect(mocks.notDelivered).not.toHaveBeenCalled()
  })

  it('keeps "wasn’t sent" for a prompt that never reached a running agent', async () => {
    mocks.receipt.mockResolvedValue('not-delivered')
    await expect(deliver()).resolves.toMatchObject({ delivered: false })
    expect(mocks.notDelivered).toHaveBeenCalled()
    expect(mocks.exited).not.toHaveBeenCalled()
  })

  // Why (final review P1-1): main reported nothing for a launch nothing waits on, and a Windows host
  // without hooks can never confirm one, so that notice would follow every such launch.
  it('stays silent for an unconfirmed prompt nothing waits on, and says so when an action waits', async () => {
    mocks.receipt.mockResolvedValue('unconfirmed')
    deliver('auto-submit')
    await vi.waitFor(() => expect(mocks.receipt).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.unconfirmed).not.toHaveBeenCalled()
    await expect(deliver('submit-after-ready')).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })
    expect(mocks.unconfirmed).toHaveBeenCalledTimes(1)
  })
})
