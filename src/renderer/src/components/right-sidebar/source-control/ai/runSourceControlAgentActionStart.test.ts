import { sourceControlActionRecipeEntry } from '../../../../../../shared/source-control/ai/recipes/source-control-action-selection'
import type { SourceControlActionRecipe } from '../../../../../../shared/source-control/ai/recipes/source-control-ai-actions'
import type * as RuntimeGitStatusClientModule from '@/runtime/source-control/git/runtime-git-status-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'

const mocks = vi.hoisted(() => ({
  focusTerminalTabSurface: vi.fn(),
  launchAgentInNewTab: vi.fn(),
  onClose: vi.fn(),
  onLaunched: vi.fn(),
  onSaveAgentDefault: vi.fn(),
  onStart: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  navigate: vi.fn(),
  mutationInFlight: vi.fn()
}))
vi.mock('@/runtime/source-control/git/runtime-git-status-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeGitStatusClientModule>()),
  getRuntimeGitMutationInFlight: mocks.mutationInFlight
}))

vi.mock('@/components/terminal-pane/input/focus/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))

vi.mock('@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab', () => ({
  launchAgentInNewTabWithOutcome: mocks.launchAgentInNewTab
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess }
}))

vi.mock('@/lib/workspace/activation/workspace-navigation-toast-action', () => ({
  workspaceNavigationToastAction: ({
    workspaceId,
    executionHostId
  }: {
    workspaceId: string
    executionHostId?: string
  }) => ({
    label: 'Go to workspace',
    onClick: () => mocks.navigate(workspaceId, executionHostId)
  })
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

const initialState = useAppStore.getState()
afterEach(() => useAppStore.setState(initialState, true))

describe('runSourceControlAgentActionStart', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({
      repos: [{ ...TEST_REPO, connectionId: 'box' }],
      worktreesByRepo: {
        [TEST_REPO.id]: [makeWorktree({ id: 'child', repoId: TEST_REPO.id, hostId: 'ssh:box' })]
      },
      folderWorkspaces: [makeFolderWorkspace({ id: 'feature', executionHostId: 'ssh:box' })]
    })
    mocks.mutationInFlight.mockResolvedValue({ inFlight: false })
  })

  it('keeps a cross-host section launch child-owned instead of executing its path in the folder', async () => {
    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace({ id: 'feature', executionHostId: 'local' })],
      activeGroupIdByWorktree: { child: 'child-group' },
      activeWorktreeId: 'folder:feature',
      activeWorkspaceKey: 'folder:feature',
      activeWorkspaceExecutionHostId: 'local',
      worktreesByRepo: {
        ...useAppStore.getState().worktreesByRepo,
        local: [
          makeWorktree({ id: 'local::/tmp/wt', repoId: 'local', path: '/tmp/wt', hostId: 'local' })
        ]
      }
    })
    mocks.launchAgentInNewTab.mockReturnValue({ surface: { kind: 'host-published' } })
    await expect(
      runSourceControlAgentActionStart(
        buildArgs({
          worktreeId: 'child',
          placementWorkspaceId: 'folder:feature',
          groupId: 'folder-group',
          initialCwd: '/tmp/wt',
          recipe: { agentId: 'codex', surface: 'chat' },
          launchChoice: {
            agent: 'codex',
            route: 'structured-native-chat',
            requestedSurface: 'chat',
            executionHostId: 'ssh:box'
          }
        })
      )
    ).resolves.toBe(true)
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'child',
        groupId: 'child-group',
        activate: false,
        requestedSurface: 'terminal',
        selectedExecutionHostId: 'ssh:box'
      })
    )
    expect(mocks.launchAgentInNewTab.mock.calls[0]?.[0]).not.toHaveProperty('initialCwd')
    expect(mocks.launchAgentInNewTab.mock.calls[0]?.[0]).not.toHaveProperty('trustWorktreeId')
    expect(useAppStore.getState().activeWorktreeId).toBe('folder:feature')
    expect(mocks.focusTerminalTabSurface).not.toHaveBeenCalled()
    expect(mocks.toastSuccess).toHaveBeenCalledOnce()
    expect(mocks.onLaunched).toHaveBeenCalledWith('child')
    expect(mocks.navigate).not.toHaveBeenCalled()
    mocks.toastSuccess.mock.calls[0]?.[1].action.onClick()
    expect(mocks.navigate).toHaveBeenCalledWith('child', 'ssh:box')
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
    useAppStore.setState({ settings: getDefaultSettings('/tmp') })
    const args = buildArgs({
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
