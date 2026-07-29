import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  focusTerminalTabSurface: vi.fn(),
  launchAgentInNewTab: vi.fn(),
  onClose: vi.fn(),
  onLaunched: vi.fn(),
  onSaveAgentDefault: vi.fn(),
  onStart: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))

vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launchAgentInNewTab
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError }
}))

import { runSourceControlAgentActionStart } from './runSourceControlAgentActionStart'

function buildArgs(
  overrides: Partial<Parameters<typeof runSourceControlAgentActionStart>[0]> = {}
): Parameters<typeof runSourceControlAgentActionStart>[0] {
  return {
    selectedAgent: 'codex',
    trimmedCommandInput: 'Fix the bug',
    agentArgs: '--model gpt-5',
    commandTemplate: '{basePrompt}',
    saveTargetValue: 'none',
    actionId: 'resolveComments',
    repoId: null,
    settings: null,
    repo: null,
    worktreeId: 'wt-1',
    groupId: 'group-1',
    promptDelivery: 'submit-after-ready',
    launchPlatform: 'linux',
    launchSource: 'source_control_recovery',
    onStart: undefined,
    onSaveAgentDefault: mocks.onSaveAgentDefault,
    onLaunched: mocks.onLaunched,
    onClose: mocks.onClose,
    ...overrides
  }
}

describe('runSourceControlAgentActionStart', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('waits for deferred prompt delivery before confirming a source-control launch', async () => {
    mocks.launchAgentInNewTab.mockReturnValue({
      tabId: 'tab-1',
      startupPlan: {} as never,
      pasteDraftAfterLaunch: true,
      promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
    })

    await expect(runSourceControlAgentActionStart(buildArgs())).resolves.toBe(true)

    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('tab-1')
    expect(mocks.onLaunched).toHaveBeenCalledTimes(1)
    expect(mocks.onClose).toHaveBeenCalledTimes(1)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('keeps the source-control dialog open when deferred prompt delivery fails', async () => {
    mocks.launchAgentInNewTab.mockReturnValue({
      tabId: 'tab-1',
      startupPlan: {} as never,
      pasteDraftAfterLaunch: true,
      promptDeliveryResult: Promise.resolve({ delivered: false, failureNotified: false })
    })

    await expect(runSourceControlAgentActionStart(buildArgs())).resolves.toBe(false)

    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('tab-1')
    expect(mocks.onLaunched).not.toHaveBeenCalled()
    expect(mocks.onClose).not.toHaveBeenCalled()
    expect(mocks.onSaveAgentDefault).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('Could not start the selected agent.')
  })

  it('does not show a generic start failure when deferred delivery already notified the user', async () => {
    mocks.launchAgentInNewTab.mockReturnValue({
      tabId: 'tab-1',
      startupPlan: {} as never,
      pasteDraftAfterLaunch: true,
      promptDeliveryResult: Promise.resolve({ delivered: false, failureNotified: true })
    })

    await expect(runSourceControlAgentActionStart(buildArgs())).resolves.toBe(false)

    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('tab-1')
    expect(mocks.onLaunched).not.toHaveBeenCalled()
    expect(mocks.onClose).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('logs and treats a rejected promptDeliveryResult as a launch failure', async () => {
    const error = new Error('boom')
    const originalConsole = console
    const consoleError = vi.fn()
    vi.stubGlobal('console', { ...originalConsole, error: consoleError })
    mocks.launchAgentInNewTab.mockReturnValue({
      tabId: 'tab-1',
      startupPlan: {} as never,
      pasteDraftAfterLaunch: true,
      promptDeliveryResult: Promise.reject(error)
    })

    try {
      await expect(runSourceControlAgentActionStart(buildArgs())).resolves.toBe(false)

      expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('tab-1')
      expect(consoleError).toHaveBeenCalledWith('promptDeliveryResult rejected', error)
      expect(mocks.onLaunched).not.toHaveBeenCalled()
      expect(mocks.onClose).not.toHaveBeenCalled()
      expect(mocks.toastError).toHaveBeenCalledWith('Could not start the selected agent.')
    } finally {
      vi.stubGlobal('console', originalConsole)
    }
  })

  it('keeps non-deferred tab launches immediate', async () => {
    mocks.launchAgentInNewTab.mockReturnValue({
      tabId: 'tab-1',
      startupPlan: {} as never,
      pasteDraftAfterLaunch: true
    })

    await expect(
      runSourceControlAgentActionStart(buildArgs({ promptDelivery: 'draft' }))
    ).resolves.toBe(true)

    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('tab-1')
    expect(mocks.onLaunched).toHaveBeenCalledTimes(1)
    expect(mocks.onClose).toHaveBeenCalledTimes(1)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('keeps injected onStart successes immediate', async () => {
    const onStart = vi.fn().mockResolvedValue(true)

    await expect(
      runSourceControlAgentActionStart(
        buildArgs({
          onStart,
          worktreeId: undefined,
          groupId: undefined
        })
      )
    ).resolves.toBe(true)

    expect(onStart).toHaveBeenCalledWith({
      agent: 'codex',
      commandInput: 'Fix the bug',
      agentArgs: '--model gpt-5'
    })
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
    expect(mocks.onLaunched).toHaveBeenCalledTimes(1)
    expect(mocks.onClose).toHaveBeenCalledTimes(1)
  })
})
