import { sourceControlActionRecipeEntry } from '../../../../../../shared/source-control/ai/recipes/source-control-action-selection'
import type { SourceControlActionRecipe } from '../../../../../../shared/source-control/ai/recipes/source-control-ai-actions'
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
import { getDefaultSettings } from '../../../../../../shared/constants'

function buildArgs(
  overrides: Partial<Omit<Parameters<typeof runSourceControlAgentActionStart>[0], 'recipe'>> & {
    recipe?: SourceControlActionRecipe
  } = {}
): Parameters<typeof runSourceControlAgentActionStart>[0] {
  return {
    selectedAgent: 'codex',
    trimmedCommandInput: 'Fix the bug',
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
    ...overrides,
    recipe: sourceControlActionRecipeEntry(
      overrides.recipe ?? {
        agentId: 'codex',
        commandInputTemplate: '{basePrompt}',
        agentArgs: '--model gpt-5'
      }
    )
  }
}

describe('runSourceControlAgentActionStart', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mutationInFlight.mockResolvedValue({ inFlight: false })
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

  // Why: irreversible host writes (fixing replies, thread resolves) hang off onLaunched, so a
  // launch whose prompt never landed must report the abort and never reach onLaunched.
  it('saves before deferred delivery and retains the recipe when delivery fails', async () => {
    let resolveDelivery = (_value: { delivered: boolean; failureNotified: boolean }): void => {}
    const promptDeliveryResult = new Promise<{ delivered: boolean; failureNotified: boolean }>(
      (resolve) => {
        resolveDelivery = resolve
      }
    )
    const onLaunchAccepted = vi.fn()
    const onLaunchAborted = vi.fn()
    const onSaveAgentDefault = vi.fn()
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-1' },
      promptDeliveryResult
    })
    const args = buildArgs({
      settings: getDefaultSettings('/tmp'),
      saveTargetValue: 'global',
      onSaveAgentDefault,
      onLaunchAccepted,
      onLaunchAborted
    })
    const launchPromise = runSourceControlAgentActionStart(args)

    expect(onSaveAgentDefault).toHaveBeenCalledWith({ type: 'global' }, 'resolveComments', {
      agentId: 'codex',
      commandInputTemplate: '{basePrompt}',
      agentArgs: '--model gpt-5'
    })
    expect(onSaveAgentDefault.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.launchAgentInNewTab.mock.invocationCallOrder[0]
    )
    expect(onLaunchAccepted).toHaveBeenCalledTimes(1)
    expect(mocks.onLaunched).not.toHaveBeenCalled()
    expect(mocks.onClose).not.toHaveBeenCalled()

    resolveDelivery({ delivered: false, failureNotified: true })
    await expect(launchPromise).resolves.toBe(false)

    expect(onSaveAgentDefault).toHaveBeenCalledOnce()
    expect(onLaunchAborted).toHaveBeenCalledTimes(1)
    expect(mocks.onLaunched).not.toHaveBeenCalled()
    expect(mocks.onClose).not.toHaveBeenCalled()
  })
})

it('confirms delivery and closes even while saving remains pending', async () => {
  mocks.launchAgentInNewTab.mockReturnValue({
    surface: { kind: 'local-terminal', tabId: 'tab-1' },
    promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
  })
  const onSaveAgentDefault = vi.fn(() => new Promise<void>(() => {}))
  const onLaunched = vi.fn()
  await expect(
    runSourceControlAgentActionStart(
      buildArgs({ saveTargetValue: 'global', onSaveAgentDefault, onLaunched })
    )
  ).resolves.toBe(true)
  expect(onLaunched).toHaveBeenCalledOnce()
  expect(mocks.onClose).toHaveBeenCalled()
})
