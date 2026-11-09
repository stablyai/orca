import { sourceControlActionRecipeEntry } from '../../../../../../shared/source-control/ai/recipes/source-control-action-selection'

import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { getRuntimeAgentInventoryKey } from '@/store/slices/agent-inventory/runtime-agent-inventory-key'

import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { clearHostAgentMenuSettingsForTests } from '@/runtime/agent-launch-settings/host-agent-launch-preferences-resource'
import {
  launchSourceControlRecoveryAgentWithDefault,
  getDefaultSourceControlRecoveryLaunchCopy
} from './recovery-launch'
import { toast } from 'sonner'
// @vitest-environment happy-dom

import type * as RuntimeGitStatusClientModule from '@/runtime/source-control/git/runtime-git-status-client'
import path from 'node:path'
import { act, cleanup, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../../../shared/constants'

import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'

const { mutationInFlight, detectAgents, launchAgent } = vi.hoisted(() => ({
  mutationInFlight: vi.fn(),
  detectAgents: vi.fn(),
  launchAgent: vi.fn()
}))
vi.mock('@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: launchAgent
}))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('@/runtime/source-control/git/runtime-git-status-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeGitStatusClientModule>()),
  getRuntimeGitMutationInFlight: mutationInFlight
}))

const navigate = vi.hoisted(() => vi.fn())
vi.mock('@/lib/workspace/activation/workspace-navigation-toast-action', () => ({
  workspaceNavigationToastAction: ({
    workspaceId,
    executionHostId
  }: {
    workspaceId: string
    executionHostId?: string
  }) => ({
    label: 'Go to workspace',
    onClick: () => navigate(workspaceId, executionHostId)
  })
}))
const initialState = useAppStore.getState()

describe('AI operation recovery composer', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.success).mockClear()
    navigate.mockClear()
    hostRpc.mockReset()
    mutationInFlight.mockReset().mockResolvedValue({ inFlight: false })
    detectAgents.mockReset().mockResolvedValue(['codex'])
    launchAgent.mockReset().mockReturnValue({ surface: { kind: 'local-terminal', tabId: 'agent' } })
    setLocalRuntimeCapabilitiesForTests([])
    useAppStore.setState({
      isRemoteOperationActive: false,
      folderWorkspaces: [makeFolderWorkspace({ id: 'feature', executionHostId: 'local' })],
      repos: [TEST_REPO],
      worktreesByRepo: {
        [TEST_REPO.id]: [
          makeWorktree({ id: 'repo1::/tmp/wt', repoId: TEST_REPO.id, hostId: 'local' })
        ]
      },
      ensureDetectedAgents: async () => {
        const ids: TuiAgent[] = await detectAgents()
        useAppStore.setState({ localDetectedAgentIdsByContext: { host: ids } })
        return ids
      },
      ensureRuntimeDetectedAgents: async (environmentId, worktreeId) => {
        const ids: TuiAgent[] = await detectAgents()
        useAppStore.setState({
          runtimeDetectedAgentIds: { [getRuntimeAgentInventoryKey(environmentId, worktreeId)]: ids }
        })
        return ids
      }
    })
  })

  afterEach(() => {
    cleanup()
    clearHostAgentMenuSettingsForTests()
    setLocalRuntimeCapabilitiesForTests(null)
    useAppStore.setState(initialState, true)
  })

  it('launches a section recovery in its folder with the child working directory', async () => {
    useAppStore.setState({
      settings: { ...getDefaultSettings(path.resolve('tmp')), defaultTuiAgent: 'codex' }
    })
    await expect(
      launchSourceControlRecoveryAgentWithDefault({
        activeWorktreeId: 'repo1::/tmp/wt',
        activeGroupId: 'folder-group',
        activeSourceControlLaunchPlatform: 'linux',
        sourceRepoConnectionId: null,
        placementWorkspaceId: 'folder:feature',
        initialCwd: '/folder/repo',
        executionHostId: 'local',
        actionId: 'fixCommitFailure',
        basePrompt: 'fix this commit',
        getLaunchActionRecipe: () =>
          sourceControlActionRecipeEntry({ agentId: 'codex', surface: 'chat' }),
        getStoreState: useAppStore.getState,
        copy: getDefaultSourceControlRecoveryLaunchCopy('commit')
      })
    ).resolves.toBe(true)
    expect(launchAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'folder:feature',
        groupId: 'folder-group',
        initialCwd: '/folder/repo',
        trustWorktreeId: 'repo1::/tmp/wt',
        selectedExecutionHostId: 'local',
        requestedSurface: 'terminal'
      })
    )
    expect(detectAgents).toHaveBeenCalledOnce()
  })

  it('uses the child workspace for cross-host recovery without applying its cwd to the folder', async () => {
    useAppStore.setState({
      settings: { ...getDefaultSettings(path.resolve('tmp')), defaultTuiAgent: 'codex' },
      folderWorkspaces: [makeFolderWorkspace({ id: 'feature', executionHostId: 'ssh:other' })],
      activeGroupIdByWorktree: { 'repo1::/tmp/wt': 'child-group' },
      activeWorktreeId: 'folder:feature',
      activeWorkspaceKey: 'folder:feature',
      activeWorkspaceExecutionHostId: 'ssh:other'
    })
    await expect(
      launchSourceControlRecoveryAgentWithDefault({
        activeWorktreeId: 'repo1::/tmp/wt',
        activeGroupId: 'folder-group',
        activeSourceControlLaunchPlatform: 'linux',
        sourceRepoConnectionId: null,
        placementWorkspaceId: 'folder:feature',
        initialCwd: '/child',
        executionHostId: 'local',
        actionId: 'fixCommitFailure',
        basePrompt: 'fix this commit',
        getLaunchActionRecipe: () =>
          sourceControlActionRecipeEntry({ agentId: 'codex', surface: 'chat' }),
        getStoreState: useAppStore.getState,
        copy: getDefaultSourceControlRecoveryLaunchCopy('commit')
      })
    ).resolves.toBe(true)
    expect(launchAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'repo1::/tmp/wt',
        groupId: 'child-group',
        activate: false,
        requestedSurface: 'terminal',
        selectedExecutionHostId: 'local'
      })
    )
    expect(launchAgent.mock.calls[0]?.[0]).not.toHaveProperty('initialCwd')
    expect(launchAgent.mock.calls[0]?.[0]).not.toHaveProperty('trustWorktreeId')
    expect(useAppStore.getState().activeWorktreeId).toBe('folder:feature')
    expect(toast.success).toHaveBeenCalledOnce()
    expect(navigate).not.toHaveBeenCalled()
    const action = vi.mocked(toast.success).mock.calls[0]?.[1]?.action
    expect(action).toEqual(expect.objectContaining({ onClick: expect.any(Function) }))
  })

  it('claims recovery success only after the terminal and task handoff settle', async () => {
    vi.mocked(toast.success).mockClear()
    const completed = Promise.withResolvers<{
      outcome: { status: 'created' }
      delivered: boolean
      failureNotified: boolean
    }>()
    const delivery = Promise.withResolvers<{ delivered: boolean; failureNotified: boolean }>()
    launchAgent.mockReturnValue({
      surface: { kind: 'host-published' },
      terminalCompletion: completed.promise,
      promptDeliveryResult: delivery.promise
    })
    useAppStore.setState({
      settings: { ...getDefaultSettings(path.resolve('tmp')), defaultTuiAgent: 'codex' }
    })
    const run = () =>
      launchSourceControlRecoveryAgentWithDefault({
        activeWorktreeId: 'repo1::/tmp/wt',
        activeGroupId: null,
        activeSourceControlLaunchPlatform: 'linux',
        sourceRepoConnectionId: null,
        actionId: 'fixCommitFailure',
        basePrompt: 'fix this commit',
        getLaunchActionRecipe: () => sourceControlActionRecipeEntry({ agentId: null }),
        getStoreState: useAppStore.getState,
        copy: getDefaultSourceControlRecoveryLaunchCopy('commit')
      })
    const starting = run()
    await waitFor(() => expect(launchAgent).toHaveBeenCalledOnce())
    expect(toast.success).not.toHaveBeenCalled()
    completed.resolve({ outcome: { status: 'created' }, delivered: false, failureNotified: false })
    await act(async () => {})
    expect(toast.success).not.toHaveBeenCalled()
    delivery.resolve({ delivered: true, failureNotified: false })
    await expect(starting).resolves.toBe(true)
    expect(toast.success).toHaveBeenCalledOnce()
    vi.mocked(toast.success).mockClear()
    launchAgent.mockReturnValue({
      surface: { kind: 'host-published' },
      terminalCompletion: Promise.resolve({
        outcome: { status: 'failed', message: '' },
        delivered: false,
        failureNotified: true
      })
    })
    await expect(run()).resolves.toBe(false)
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })
})

const hostRpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: hostRpc
}))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: async () => true
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() } }))
