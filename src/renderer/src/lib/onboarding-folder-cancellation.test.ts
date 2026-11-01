import type * as RuntimeRpc from '@/runtime/runtime-rpc-client'
import type * as Telemetry from '@/lib/telemetry'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { createTestStore, makeWorktree } from '@/store/slices/store-test-helpers'
import { makeDetectedResult } from '@/store/slices/worktrees-detected-listing-fixtures'
import { getDefaultSettings } from '../../../shared/constants'
import { getDefaultOnboardingState } from '../../../shared/onboarding-defaults'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { projectAgentLaunchSettings } from '../../../shared/agent-launch-settings'
import { clearHostAgentMenuSettingsForTests } from '@/components/settings/use-host-agent-launch-preferences'
import { stubRuntimeEnvironmentBridge } from '@/runtime/runtime-environment-bridge-fixture'
import { rememberEmptyHostAnswerForTests } from '@/runtime/web-session-tabs-sync/host-terminal-count-fixture'
import { loadWebRuntimeSessionTabsApplyModulesForTests } from '@/runtime/web-runtime-session-snapshot'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '@/runtime/web-session-tabs-sync/tracking-lifecycle'
import {
  shouldSkipWebRuntimeWakeTerminalRespawn,
  resetWebRuntimeWakeTerminalRespawnForTests
} from '@/runtime/web-runtime-wake-terminal-respawn'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpc>()),
  runtimeEnvironmentSupportsCapability: vi.fn(async () => true),
  callRuntimeRpc: rpc
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), dismiss: vi.fn() }
}))
vi.mock('@/lib/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof Telemetry>()),
  track: vi.fn()
}))

beforeAll(loadWebRuntimeSessionTabsApplyModulesForTests)
afterEach(() => {
  clearHostAgentMenuSettingsForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
  resetWebRuntimeWakeTerminalRespawnForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function environment(revision: number): PublicKnownRuntimeEnvironment {
  return {
    id: 'box',
    name: 'Box',
    createdAt: 1,
    updatedAt: revision,
    pairingRevision: revision,
    lastUsedAt: null,
    runtimeId: 'box-runtime',
    endpoints: [],
    preferredEndpointId: 'endpoint',
    hostKeyFingerprint: 'same-host'
  }
}

it.each(['same-host', 'purged'] as const)(
  'keeps the committed folder after optional cancellation and reveals only its %s owner',
  async (mode) => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    const store = createTestStore()
    vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
    vi.spyOn(useAppStore, 'setState').mockImplementation(store.setState)
    store.setState({
      settings: {
        ...getDefaultSettings('/tmp/workspaces'),
        defaultTuiAgent: 'claude',
        agentDefaultArgs: { claude: '--model old-seed' },
        activeRuntimeEnvironmentId: 'box'
      }
    })
    store.getState().setRuntimeEnvironments([environment(1)])
    store.setState({
      runtimeStatusByEnvironmentId: new Map([
        [
          'box',
          {
            checkedAt: 1,
            status: {
              runtimeId: 'box-runtime',
              rendererGraphEpoch: 0,
              graphStatus: 'ready',
              authoritativeWindowId: null,
              liveTabCount: 0,
              liveLeafCount: 0,
              hostPlatform: 'linux',
              capabilities: []
            }
          }
        ]
      ])
    })
    const folder = makeWorktree({
      id: 'folder-repo::/folder',
      repoId: 'folder-repo',
      path: '/folder'
    })
    const pending = Promise.withResolvers<{
      settings: ReturnType<typeof projectAgentLaunchSettings>
    }>()
    rpc.mockImplementation(async (_target, method) => {
      if (method === 'repo.add') {
        return {
          repo: {
            id: 'folder-repo',
            path: '/folder',
            displayName: 'Folder',
            badgeColor: '',
            addedAt: 1,
            kind: 'folder'
          }
        }
      }
      if (method === 'worktree.detectedList') {
        return makeDetectedResult('folder-repo', [folder])
      }
      if (method === 'github.prForBranch') {
        return null
      }
      if (method === 'worktree.lineageList') {
        return { lineage: {} }
      }
      if (method === 'settings.getAgentLaunch') {
        return pending.promise
      }
      throw new Error(`Unexpected RPC ${method}`)
    })
    const dispatch = vi.fn(
      async (request: {
        method: string
        expectedEnvironmentPairingRevision?: number
        params?: unknown
      }) => {
        if (request.method === 'session.tabs.createTerminal') {
          return { ok: true, result: { tab: { id: 'plain-tab', leafId: 'leaf' } } }
        }
        if (request.method === 'session.tabs.list') {
          return {
            ok: true,
            result: {
              worktree: folder.id,
              publicationEpoch: 'epoch',
              snapshotVersion: 1,
              activeGroupId: null,
              activeTabId: null,
              activeTabType: null,
              tabs: []
            }
          }
        }
        if (request.method === 'worktree.activate') {
          return { ok: true, result: {} }
        }
        throw new Error(`Unexpected dispatch ${request.method}`)
      }
    )
    stubRuntimeEnvironmentBridge({ call: dispatch })
    Object.assign(window.api, {
      onboarding: {
        get: vi.fn(async () => ({ ...getDefaultOnboardingState(), outcome: 'dismissed' })),
        update: vi.fn(async () => undefined)
      }
    })
    const adding = store.getState().addNonGitFolder('/folder', { runtimeEnvironmentId: 'box' })
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() =>
      expect(
        rpc.mock.calls.filter(([, method]) => method === 'settings.getAgentLaunch')
      ).toHaveLength(1)
    )
    expect(store.getState().getKnownWorktreeById(folder.id)).toBeDefined()
    expect(dispatch).not.toHaveBeenCalled()
    store.getState().setRuntimeEnvironments(mode === 'same-host' ? [environment(2)] : [])
    if (mode === 'same-host') {
      rememberEmptyHostAnswerForTests('box', folder.id)
    }
    await vi.advanceTimersByTimeAsync(0)
    await expect(adding).resolves.toMatchObject({
      id: 'folder-repo',
      executionHostId: 'runtime:box'
    })
    await vi.advanceTimersByTimeAsync(0)
    const creates = () =>
      dispatch.mock.calls.filter(([request]) => request.method === 'session.tabs.createTerminal')
    if (mode === 'same-host') {
      expect(store.getState().activeWorktreeId).toBe(folder.id)
      expect(creates()).toHaveLength(1)
      expect(creates()[0][0]).toMatchObject({ expectedEnvironmentPairingRevision: 2 })
      expect(creates()[0][0].params).toMatchObject({ command: undefined })
      expect(creates()[0][0].params).not.toHaveProperty('launchAgent')
      expect(
        dispatch.mock.calls.find(([request]) => request.method === 'worktree.activate')?.[0]
      ).toMatchObject({ expectedEnvironmentPairingRevision: 2 })
    } else {
      expect(store.getState().getKnownWorktreeById(folder.id)).toBeUndefined()
      expect(store.getState().repos).toEqual([])
      expect(dispatch).not.toHaveBeenCalled()
    }
    expect(shouldSkipWebRuntimeWakeTerminalRespawn(folder.id)).toBe(false)
    pending.resolve({
      settings: projectAgentLaunchSettings({
        agentLaunchChoices: { claude: { model: 'late-seed' } }
      })
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(creates()).toHaveLength(mode === 'same-host' ? 1 : 0)
    expect(
      dispatch.mock.calls.some(([request]) => request.method === 'terminal.createAgentSession')
    ).toBe(false)
    expect(store.getState().tabsByWorktree[folder.id] ?? []).toEqual([])
    expect(toast.error).not.toHaveBeenCalled()
  }
)
