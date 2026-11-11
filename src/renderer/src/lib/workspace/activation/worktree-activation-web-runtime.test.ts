import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../../../shared/agent-launch/startup/setup-agent-sequencing'
import { activateAndRevealWorktreeWithOutcome } from './worktree-activation'
import { ensureWorktreeHasInitialTerminal } from '@/lib/workspace/activation/initial-surface/worktree-initial-terminal-seeding'

import {
  type AppStoreState,
  createMockStore,
  registerWorktreeActivationReset
} from './worktree-activation.test-fixture'
import { useAppStore } from '@/store/index'
import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from './worktree-activation-created-agent.test-fixture'
import { resetWebRuntimeWakeTerminalRespawnForTests } from '@/runtime/hosted-terminals/restoration/web-runtime-wake-terminal-respawn'
import '../../../runtime/rpc/testing/runtime-environment-bridge-fixture'
import '@/runtime/web-session-tabs-sync/host-terminal-count-fixture'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '@/runtime/web-session-tabs-sync/tracking-lifecycle'

registerWorktreeActivationReset()
const originalCreateTab = useAppStore.getState().createTab
const originalSetActiveWorktree = useAppStore.getState().setActiveWorktree

afterEach(() => {
  useAppStore.setState({
    createTab: originalCreateTab,
    setActiveWorktree: originalSetActiveWorktree
  })
  vi.unstubAllGlobals()
  resetWebRuntimeWakeTerminalRespawnForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
})

describe('ensureWorktreeHasInitialTerminal', () => {
  it('holds the issue command for the first mirrored web runtime tab when none exists yet', () => {
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    useAppStore.setState((state) => ({
      settings: state.settings
        ? { ...state.settings, activeRuntimeEnvironmentId: 'web-runtime-1' }
        : ({ activeRuntimeEnvironmentId: 'web-runtime-1' } as unknown as typeof state.settings),
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-1',
            repoId: 'repo-1',
            hostId: 'local',
            runtimeOwnerEnvironmentId: 'web-runtime-1'
          }
        ] as never
      }
    }))
    useAppStore.setState({
      tabsByWorktree: {},
      getKnownWorktreeById: ((id: string) =>
        id === 'wt-1'
          ? { id: 'wt-1' }
          : undefined) as unknown as AppStoreState['getKnownWorktreeById']
    } as Partial<AppStoreState>)
    const store = createMockStore()

    const result = ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, undefined, {
      command: 'gh issue view 42'
    })

    // Why: runtime session tabs mirror in asynchronously — the command must be
    // held for the first mirrored tab rather than silently dropped.
    expect(result).toBeNull()
    expect(useAppStore.getState().pendingIssueCommandSplitByTabId).toEqual({})

    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [{ id: 'mirror-tab-1' }] }
    } as unknown as Partial<AppStoreState>)

    expect(useAppStore.getState().pendingIssueCommandSplitByTabId['mirror-tab-1']).toEqual({
      command: 'gh issue view 42'
    })
  })
})

it('accepts live paired startup through after-wake when initial seeding returns no primary tab', async () => {
  const worktree = makeCreatedAgentWorktree()
  seedEmptyActivatableWorktree(worktree)
  useAppStore.setState((state) => ({
    repos: state.repos.map((repo) => ({ ...repo, executionHostId: 'runtime:paired' as const })),
    worktreesByRepo: { [worktree.repoId]: [{ ...worktree, runtimeOwnerEnvironmentId: 'paired' }] }
  }))
  const runtimeCall = vi.fn(async (args: { method: string }) => ({
    id: 'reply',
    ok: true,
    result:
      args.method === 'status.get'
        ? { runtimeProtocolVersion: 3, minCompatibleRuntimeClientVersion: 2, capabilities: [] }
        : args.method === 'session.tabs.createTerminal'
          ? { tab: { id: 'host-tab', leafId: '11111111-1111-4111-8111-111111111111' } }
          : { worktree: worktree.id, tabs: [] },
    _meta: { runtimeId: 'paired-runtime' }
  }))
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })
  const result = activateAndRevealWorktreeWithOutcome(worktree.id, {
    runtimeEnvironmentId: 'paired',
    startup: { command: 'codex', launchAgent: 'codex', launchToken: 'launch-1' }
  })
  expect(result).toEqual({ opened: { primaryTabId: null, startupAccepted: true } })
  await vi.waitFor(() =>
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'session.tabs.createTerminal' })
    )
  )
})
