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

  it('notifies onLaunchAccepted as soon as the agent tab is created, before prompt delivery', async () => {
    let resolveDelivery: (value: {
      delivered: boolean
      failureNotified: boolean
    }) => void = () => {}
    const promptDeliveryResult = new Promise<{ delivered: boolean; failureNotified: boolean }>(
      (resolve) => {
        resolveDelivery = resolve
      }
    )
    const onLaunchAccepted = vi.fn()
    const onLaunchAborted = vi.fn()
    mocks.launchAgentInNewTab.mockReturnValue({
      tabId: 'tab-1',
      startupPlan: {} as never,
      pasteDraftAfterLaunch: true,
      promptDeliveryResult
    })

    const launchPromise = runSourceControlAgentActionStart(
      buildArgs({ onLaunchAccepted, onLaunchAborted })
    )

    await vi.waitFor(() => {
      expect(onLaunchAccepted).toHaveBeenCalledTimes(1)
    })
    expect(mocks.onLaunched).not.toHaveBeenCalled()

    resolveDelivery({ delivered: true, failureNotified: false })
    await expect(launchPromise).resolves.toBe(true)
    expect(mocks.onLaunched).toHaveBeenCalledTimes(1)
    expect(onLaunchAborted).not.toHaveBeenCalled()
  })

  // Why: onLaunchAccepted only parks launch-scoped state; firing it twice or on a dead
  // launch would leave a caller believing an agent is running.
  it('fires onLaunchAccepted exactly once and only when a tab was created', async () => {
    const onLaunchAccepted = vi.fn()
    mocks.launchAgentInNewTab.mockReturnValue({
      tabId: 'tab-1',
      startupPlan: {} as never,
      pasteDraftAfterLaunch: true,
      promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
    })

    await expect(runSourceControlAgentActionStart(buildArgs({ onLaunchAccepted }))).resolves.toBe(
      true
    )
    expect(onLaunchAccepted).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    mocks.launchAgentInNewTab.mockReturnValue(null)

    await expect(runSourceControlAgentActionStart(buildArgs({ onLaunchAccepted }))).resolves.toBe(
      false
    )
    expect(onLaunchAccepted).not.toHaveBeenCalled()
  })

  // Why: irreversible host writes (fixing replies, thread resolves) hang off onLaunched, so a
  // launch whose prompt never landed must report the abort and never reach onLaunched.
  it('aborts an accepted launch when deferred prompt delivery fails', async () => {
    const onLaunchAccepted = vi.fn()
    const onLaunchAborted = vi.fn()
    mocks.launchAgentInNewTab.mockReturnValue({
      tabId: 'tab-1',
      startupPlan: {} as never,
      pasteDraftAfterLaunch: true,
      promptDeliveryResult: Promise.resolve({ delivered: false, failureNotified: true })
    })

    await expect(
      runSourceControlAgentActionStart(buildArgs({ onLaunchAccepted, onLaunchAborted }))
    ).resolves.toBe(false)

    expect(onLaunchAccepted).toHaveBeenCalledTimes(1)
    expect(onLaunchAborted).toHaveBeenCalledTimes(1)
    expect(mocks.onLaunched).not.toHaveBeenCalled()
  })

  it('aborts an accepted launch when promptDeliveryResult rejects', async () => {
    const onLaunchAccepted = vi.fn()
    const onLaunchAborted = vi.fn()
    const originalConsole = console
    vi.stubGlobal('console', { ...originalConsole, error: vi.fn() })
    mocks.launchAgentInNewTab.mockReturnValue({
      tabId: 'tab-1',
      startupPlan: {} as never,
      pasteDraftAfterLaunch: true,
      promptDeliveryResult: Promise.reject(new Error('boom'))
    })

    try {
      await expect(
        runSourceControlAgentActionStart(buildArgs({ onLaunchAccepted, onLaunchAborted }))
      ).resolves.toBe(false)

      expect(onLaunchAccepted).toHaveBeenCalledTimes(1)
      expect(onLaunchAborted).toHaveBeenCalledTimes(1)
      expect(mocks.onLaunched).not.toHaveBeenCalled()
    } finally {
      vi.stubGlobal('console', originalConsole)
    }
  })

  it('does not report an abort when no tab was ever created', async () => {
    const onLaunchAborted = vi.fn()
    mocks.launchAgentInNewTab.mockReturnValue(null)

    await expect(runSourceControlAgentActionStart(buildArgs({ onLaunchAborted }))).resolves.toBe(
      false
    )

    expect(onLaunchAborted).not.toHaveBeenCalled()
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

  // Why: the onStart branch never awaits a delivery result, so acceptance is terminal there.
  it('accepts an onStart launch and never aborts it', async () => {
    const onLaunchAccepted = vi.fn()
    const onLaunchAborted = vi.fn()
    const onStart = vi.fn().mockResolvedValue(true)

    await expect(
      runSourceControlAgentActionStart(
        buildArgs({
          onStart,
          worktreeId: undefined,
          groupId: undefined,
          onLaunchAccepted,
          onLaunchAborted
        })
      )
    ).resolves.toBe(true)

    expect(onLaunchAccepted).toHaveBeenCalledTimes(1)
    expect(onLaunchAborted).not.toHaveBeenCalled()
    expect(mocks.onLaunched).toHaveBeenCalledTimes(1)
  })

  it('reports neither callback when onStart declines the launch', async () => {
    const onLaunchAccepted = vi.fn()
    const onLaunchAborted = vi.fn()
    const onStart = vi.fn().mockResolvedValue(false)

    await expect(
      runSourceControlAgentActionStart(
        buildArgs({
          onStart,
          worktreeId: undefined,
          groupId: undefined,
          onLaunchAccepted,
          onLaunchAborted
        })
      )
    ).resolves.toBe(false)

    expect(onLaunchAccepted).not.toHaveBeenCalled()
    expect(onLaunchAborted).not.toHaveBeenCalled()
  })

  // Why: a rejected recipe save after acceptance would otherwise strand the caller with
  // neither onLaunched nor onLaunchAborted, permanently disabling the action.
  it('completes the launch when saving the agent default rejects', async () => {
    const onLaunchAborted = vi.fn()
    const originalConsole = console
    const consoleError = vi.fn()
    vi.stubGlobal('console', { ...originalConsole, error: consoleError })
    mocks.onSaveAgentDefault.mockRejectedValue(new Error('settings not loaded'))
    mocks.launchAgentInNewTab.mockReturnValue({
      tabId: 'tab-1',
      startupPlan: {} as never,
      pasteDraftAfterLaunch: true,
      promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
    })

    try {
      await expect(
        runSourceControlAgentActionStart(buildArgs({ saveTargetValue: 'global', onLaunchAborted }))
      ).resolves.toBe(true)

      expect(mocks.onSaveAgentDefault).toHaveBeenCalledTimes(1)
      expect(mocks.onLaunched).toHaveBeenCalledTimes(1)
      expect(mocks.onClose).toHaveBeenCalledTimes(1)
      expect(onLaunchAborted).not.toHaveBeenCalled()
    } finally {
      vi.stubGlobal('console', originalConsole)
    }
  })
})
