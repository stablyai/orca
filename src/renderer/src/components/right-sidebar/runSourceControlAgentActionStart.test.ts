import type * as RuntimeGitStatusClientModule from '@/runtime/runtime-git-status-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  focusTerminalTabSurface: vi.fn(),
  launchAgentInNewTab: vi.fn(),
  onClose: vi.fn(),
  onLaunched: vi.fn(),
  onSaveAgentDefault: vi.fn(),
  onStart: vi.fn(),
  toastError: vi.fn(),
  mutationInFlight: vi.fn()
}))
vi.mock('@/runtime/runtime-git-status-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeGitStatusClientModule>()),
  getRuntimeGitMutationInFlight: mocks.mutationInFlight
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
import { getDefaultSettings } from '../../../../shared/constants'
import { resolveSourceControlActionRecipe } from '../../../../shared/source-control-ai-operation-policy'
import { saveSourceControlActionRecipe } from '../../../../shared/source-control-ai-recipe-save'
import { sourceControlActionLaunchOptions } from '../../../../shared/source-control-action-launch-preferences'
import {
  resolveAgentLaunchCommand,
  terminalSessionOptionInputs
} from '../../../../shared/tui-agent-launch-command'
import type { Repo } from '../../../../shared/repo-types'

function buildArgs(
  overrides: Partial<Parameters<typeof runSourceControlAgentActionStart>[0]> = {}
): Parameters<typeof runSourceControlAgentActionStart>[0] {
  return {
    selectedAgent: 'codex',
    trimmedCommandInput: 'Fix the bug',
    agentArgs: '--model gpt-5',
    agentArgsApply: true,
    recipe: { agentId: 'codex', commandInputTemplate: '{basePrompt}', agentArgs: '--model gpt-5' },
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
    mocks.mutationInFlight.mockResolvedValue({ inFlight: false })
  })

  it('rejects conflict recovery before creating a tab when Git is still running', async () => {
    const onLaunchAccepted = vi.fn()
    mocks.mutationInFlight.mockResolvedValue({ inFlight: true })
    await expect(
      runSourceControlAgentActionStart(
        buildArgs({
          actionId: 'resolveConflicts',
          onLaunchAccepted,
          recoveryContext: { target: { kind: 'local' }, worktreeId: 'wt-1', worktreePath: '/repo' }
        })
      )
    ).resolves.toBe(false)
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
    expect(mocks.focusTerminalTabSurface).not.toHaveBeenCalled()
    expect(onLaunchAccepted).not.toHaveBeenCalled()
    expect(mocks.onLaunched).not.toHaveBeenCalled()
    expect(mocks.onSaveAgentDefault).not.toHaveBeenCalled()
    expect(mocks.onClose).not.toHaveBeenCalled()
  })

  it('does not gate conflict launches that are not paused-operation recovery', async () => {
    mocks.mutationInFlight.mockResolvedValue({ inFlight: true })
    await runSourceControlAgentActionStart(buildArgs({ actionId: 'resolveConflicts' }))
    expect(mocks.mutationInFlight).not.toHaveBeenCalled()
    expect(mocks.launchAgentInNewTab).toHaveBeenCalled()
  })

  it('waits for deferred prompt delivery before confirming a source-control launch', async () => {
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-1' },
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
      surface: { kind: 'local-terminal', tabId: 'tab-1' },
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

  // Acceptance parks launch state; duplicate or dead-launch callbacks would falsely imply an agent is running.
  it('fires onLaunchAccepted exactly once and only when a tab was created', async () => {
    const onLaunchAccepted = vi.fn()
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-1' },
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

  // Failed delivery must abort before onLaunched can post irreversible host replies/resolutions.
  it('aborts an accepted launch when deferred prompt delivery fails', async () => {
    const onLaunchAccepted = vi.fn()
    const onLaunchAborted = vi.fn()
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-1' },
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
      surface: { kind: 'local-terminal', tabId: 'tab-1' },
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
      surface: { kind: 'local-terminal', tabId: 'tab-1' },
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
      surface: { kind: 'local-terminal', tabId: 'tab-1' },
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
      surface: { kind: 'local-terminal', tabId: 'tab-1' },
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
      surface: { kind: 'local-terminal', tabId: 'tab-1' },
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

  // onStart awaits no delivery result, so acceptance is terminal for that route.
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

  // Recipe-save rejection after acceptance must still settle callbacks or the action stays disabled indefinitely.
  it('completes the launch when saving the agent default rejects', async () => {
    const onLaunchAborted = vi.fn()
    const originalConsole = console
    const consoleError = vi.fn()
    vi.stubGlobal('console', { ...originalConsole, error: consoleError })
    mocks.onSaveAgentDefault.mockRejectedValue(new Error('settings not loaded'))
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-1' },
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

describe('runSourceControlAgentActionStart CLI arguments applicability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Undefined selects global agent arguments; empty string would suppress that fallback.
  it('omits the per-action arguments so a terminal launch resolves the global setting', async () => {
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-1' }
    })

    await expect(
      runSourceControlAgentActionStart(buildArgs({ agentArgsApply: false }))
    ).resolves.toBe(true)

    expect(mocks.launchAgentInNewTab).toHaveBeenCalledTimes(1)
    const launchCall = mocks.launchAgentInNewTab.mock.calls[0]?.[0]
    expect(launchCall).toHaveProperty('agentArgs', undefined)
  })

  it('omits them on the onStart branch too', async () => {
    const onStart = vi.fn().mockResolvedValue(true)

    await expect(
      runSourceControlAgentActionStart(
        buildArgs({ agentArgsApply: false, onStart, worktreeId: undefined, groupId: undefined })
      )
    ).resolves.toBe(true)

    expect(onStart).toHaveBeenCalledWith({
      agent: 'codex',
      commandInput: 'Fix the bug',
      agentArgs: undefined
    })
  })

  // Omitting a field must not overwrite saved terminal arguments.
  it('still saves the recipe with the arguments the user had stored', async () => {
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-1' }
    })

    await runSourceControlAgentActionStart(
      buildArgs({ agentArgsApply: false, saveTargetValue: 'global' })
    )

    expect(mocks.onSaveAgentDefault).toHaveBeenCalledWith(
      expect.anything(),
      'resolveComments',
      expect.objectContaining({ agentArgs: '--model gpt-5' })
    )
  })
})

it('executes the actual bound namespace while saving the literal default recipe', async () => {
  const recipe = {
    agentId: null,
    commandInputTemplate: '{basePrompt}',
    agentArgs: '',
    launchPreferences: { agentId: 'codex' as const, model: 'chosen' }
  }
  const onStart = vi.fn().mockResolvedValue(true)
  await runSourceControlAgentActionStart(
    buildArgs({ recipe, onStart, selectedAgent: 'codex', saveTargetValue: 'global' })
  )
  expect(onStart).toHaveBeenCalledWith(
    expect.objectContaining({ sessionOptions: { model: 'chosen' } })
  )
  expect(mocks.onSaveAgentDefault).toHaveBeenLastCalledWith(
    { type: 'global' },
    'resolveComments',
    recipe
  )
})

// Saved to the repository, the copied choice owns the action there, as on every later launch.
it.each(['--model gpt-5.6-luna', '--model gpt-5.6-sol'])(
  'persists the complete target for changed or unchanged Customize arguments %s',
  async (agentArgs) => {
    vi.clearAllMocks()
    const base = getDefaultSettings('/tmp')
    const terra = { agentId: 'codex' as const, model: 'gpt-5.6-terra' }
    const fixCommitFailure = {
      agentId: null,
      commandInputTemplate: '{basePrompt}',
      launchPreferences: terra
    }
    const settings = {
      ...base,
      sourceControlAi: { ...base.sourceControlAi!, actions: { fixCommitFailure } }
    }
    const legacy = { agentArgs: '--model gpt-5.6-sol' }
    const repo: Pick<Repo, 'id' | 'sourceControlAi'> = {
      id: 'repo-1',
      sourceControlAi: { actionOverrides: { fixCommitFailure: legacy } }
    }
    const shown = resolveSourceControlActionRecipe({ settings, repo, actionId: 'fixCommitFailure' })
    mocks.launchAgentInNewTab.mockReturnValue({ surface: { kind: 'local-terminal', tabId: 't' } })
    const recipe = { ...shown, agentArgs }
    mocks.onSaveAgentDefault.mockImplementation((target, actionId, recipe) => {
      const saved = saveSourceControlActionRecipe({ target, actionId, recipe, settings, repo })
      if ('update' in saved) {
        repo.sourceControlAi = saved.update.sourceControlAi ?? undefined
      }
    })
    const args = { recipe, agentArgs, settings, repo, saveTargetValue: 'repo', repoId: 'repo-1' }

    await runSourceControlAgentActionStart(buildArgs({ ...args, actionId: 'fixCommitFailure' }))

    expect(shown.launchPreferencesYieldToAgentArgs).toBe(true)
    expect(mocks.launchAgentInNewTab.mock.lastCall?.[0]).toMatchObject({
      agentArgs: `--dangerously-bypass-approvals-and-sandbox ${agentArgs}`,
      sessionOptions: { model: 'gpt-5.6-terra' }
    })
    expect(mocks.launchAgentInNewTab.mock.lastCall?.[0]).not.toHaveProperty(
      'sessionOptionsYieldToAgentArgs'
    )
    expect(repo.sourceControlAi?.actionOverrides?.fixCommitFailure).toEqual({
      agentId: null,
      commandInputTemplate: '{basePrompt}',
      agentArgs,
      launchPreferences: terra
    })
    const next = resolveSourceControlActionRecipe({ settings, repo, actionId: 'fixCommitFailure' })
    const nextOptions = sourceControlActionLaunchOptions(next, 'codex')
    expect(nextOptions).toEqual({ sessionOptions: { model: terra.model } })
    const command = resolveAgentLaunchCommand({
      agent: 'codex',
      cmdOverrides: {},
      platform: 'linux',
      shell: 'posix',
      agentArgs,
      ...terminalSessionOptionInputs({
        agent: 'codex',
        agentArgs,
        shell: 'posix',
        sessionOptions: nextOptions.sessionOptions,
        yieldToAgentArgs: nextOptions.sessionOptionsYieldToAgentArgs
      })
    })
    expect(command).toMatchObject({ ok: true, appliedSessionOptions: { model: terra.model } })
    if (command.ok) {
      expect(command.command).not.toContain(agentArgs.split(' ')[1])
    }
    expect(mocks.onSaveAgentDefault).toHaveBeenCalledTimes(1)
    await runSourceControlAgentActionStart(
      buildArgs({ ...args, recipe: next, actionId: 'fixCommitFailure' })
    )
    expect(mocks.onSaveAgentDefault).toHaveBeenCalledTimes(1)
  }
)
