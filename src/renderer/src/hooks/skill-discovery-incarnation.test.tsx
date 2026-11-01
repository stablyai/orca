// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { SkillDiscoveryResult } from '../../../shared/skills'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { useActiveProjectSkillRuntime } from './useActiveProjectSkillRuntime'
import { useInstalledAgentSkill } from './useInstalledAgentSkills'
import { resetSkillDiscoveryCacheForTests } from './installed-agent-skill-discovery'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc,
  clearRuntimeCompatibilityCache: vi.fn(),
  clearRecentRuntimeCompatibilityFailure: vi.fn()
}))

afterEach(() => {
  resetSkillDiscoveryCacheForTests()
  rpc.mockReset()
  Reflect.deleteProperty(window, 'api')
})

it.each([
  ['completed', 'workspace'],
  ['pending', 'workspace'],
  ['completed', 'global'],
  ['pending', 'global'],
  ['completed', 'process'],
  ['pending', 'process']
] as const)(
  'retires a %s scan through stable %s resolution on same-ID replacement',
  async (phase, scope) => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        platform: { get: () => ({ platform: 'linux' }) }
      }
    })
    const workspace = makeWorktree({
      id: 'repo::/remote',
      repoId: 'repo',
      hostId: 'runtime:paired'
    })
    const environment = {
      id: 'paired',
      name: 'Paired',
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
      runtimeId: null,
      endpoints: [],
      preferredEndpointId: 'endpoint'
    }
    useAppStore.setState({
      activeRepoId: 'repo',
      activeWorktreeId: workspace.id,
      activeWorkspaceExecutionHostId: 'runtime:paired',
      worktreesByRepo: { repo: [workspace] },
      projects: [],
      repos: [],
      folderWorkspaces: [],
      projectGroups: [],
      restoredRuntimeHostIdByWorkspaceSessionKey: {},
      runtimeEnvironmentCatalogSettled: true,
      runtimeStatusByEnvironmentId: new Map(),
      settings: getDefaultSettings('/tmp'),
      runtimeEnvironments: [environment]
    })
    if (scope === 'global') {
      useAppStore.setState({
        activeRepoId: null,
        activeWorktreeId: null,
        activeWorkspaceExecutionHostId: null,
        settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'paired' }
      })
    }
    const processStatus: RuntimeStatus = {
      runtimeId: 'old',
      rendererGraphEpoch: 0,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0
    }
    if (scope === 'process') {
      useAppStore.getState().setRuntimeEnvironmentStatus('paired', {
        status: processStatus,
        checkedAt: 1
      })
    }
    const oldResult: SkillDiscoveryResult = {
      skills: [
        {
          id: 'skill',
          name: 'orca-cli',
          description: null,
          providers: [],
          sourceKind: 'home',
          sourceLabel: 'Home',
          rootPath: '/skills',
          directoryPath: '/skills/orca-cli',
          skillFilePath: '/skills/orca-cli/SKILL.md',
          installed: true,
          updatedAt: null
        }
      ],
      sources: [],
      scannedAt: 1
    }
    let finishOld!: (value: SkillDiscoveryResult) => void
    let finishNew!: (value: SkillDiscoveryResult) => void
    rpc
      .mockReturnValueOnce(
        phase === 'completed'
          ? Promise.resolve(oldResult)
          : new Promise((resolve) => {
              finishOld = resolve
            })
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishNew = resolve
        })
      )
    const { result } = renderHook(() => {
      const runtime = useActiveProjectSkillRuntime()
      return useInstalledAgentSkill('orca-cli', { runtimeTarget: runtime.discoveryRuntimeTarget })
    })
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1))
    if (phase === 'completed') {
      await waitFor(() => expect(result.current.installed).toBe(true))
    }
    act(() => {
      if (scope === 'process') {
        useAppStore.getState().setRuntimeEnvironmentStatus('paired', {
          status: { ...processStatus, runtimeId: 'replacement' },
          checkedAt: 2
        })
      } else {
        useAppStore.getState().setRuntimeEnvironments([{ ...environment, pairingRevision: 2 }])
      }
    })
    expect(result.current.installed).toBe(false)
    expect(result.current.settled).toBe(false)
    // A new peer must publish its workspace rows before setup can resolve that owner again.
    act(() =>
      useAppStore.setState({
        activeRepoId: 'repo',
        activeWorktreeId: workspace.id,
        activeWorkspaceExecutionHostId: 'runtime:paired',
        worktreesByRepo: { repo: [workspace] }
      })
    )
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2))
    if (phase === 'pending') {
      await act(async () => {
        finishOld(oldResult)
      })
      expect(result.current.installed).toBe(false)
      expect(result.current.settled).toBe(false)
    }
    await act(async () => {
      finishNew({ skills: [], sources: [], scannedAt: 2 })
    })
    expect(result.current.settled).toBe(true)
    expect(result.current.installed).toBe(false)
  }
)
