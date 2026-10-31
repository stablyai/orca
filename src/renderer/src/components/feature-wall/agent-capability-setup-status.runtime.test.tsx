// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { makeFolderWorkspace, makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { resetSkillDiscoveryCacheForTests } from '@/hooks/installed-agent-skill-discovery'
import { getLocalPreflightContext, localPreflightContextKey } from '@/lib/local-preflight-context'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { useSetupGuideProgress } from '../setup-guide/use-setup-guide-progress'
import {
  isAgentCapabilityReadinessChecking,
  useAgentCapabilitySetupStatus
} from './agent-capability-setup-status'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))

afterEach(() => {
  resetSkillDiscoveryCacheForTests()
  rpc.mockReset()
  Reflect.deleteProperty(window, 'api')
})

it('reports skills from the workspace owner rather than the focused paired transport', async () => {
  const skill = {
    id: 'browser',
    name: 'orca-cli',
    description: null,
    providers: [],
    sourceKind: 'home',
    sourceLabel: 'Home',
    rootPath: '/home/skills',
    directoryPath: '/home/skills/orca-cli',
    skillFilePath: '/home/skills/orca-cli/SKILL.md',
    installed: true,
    updatedAt: null
  }
  const localDiscover = vi.fn().mockResolvedValue({ skills: [skill], sources: [], scannedAt: 1 })
  rpc.mockResolvedValue({ skills: [], sources: [], scannedAt: 1 })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      platform: { get: () => ({ platform: 'darwin' }) },
      skills: { discover: localDiscover }
    }
  })
  const local = makeWorktree({ id: 'repo::/local', repoId: 'repo', hostId: 'local' })
  const remote = makeWorktree({ id: 'repo::/remote', repoId: 'repo', hostId: 'runtime:paired' })
  useAppStore.setState({
    activeRepoId: 'repo',
    activeWorktreeId: local.id,
    activeWorkspaceExecutionHostId: 'local',
    worktreesByRepo: { repo: [local, remote] },
    projects: [],
    repos: [],
    folderWorkspaces: [],
    projectGroups: [],
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    runtimeEnvironmentCatalogSettled: true,
    settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'paired' },
    runtimeEnvironments: [
      {
        id: 'paired',
        name: 'Paired',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        endpoints: [],
        preferredEndpointId: 'endpoint'
      }
    ]
  })
  const { result, unmount } = renderHook(() => useAgentCapabilitySetupStatus())
  await waitFor(() => expect(result.current.readiness.browserUseSkillInstalled).toBe(true))
  act(() =>
    useAppStore.setState({
      activeWorktreeId: remote.id,
      activeWorkspaceExecutionHostId: 'runtime:paired'
    })
  )
  await waitFor(() => {
    expect(result.current.readiness.browserUseSkillLoading).toBe(false)
    expect(result.current.readiness.browserUseSkillInstalled).toBe(false)
  })
  expect(rpc).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'environment', environmentId: 'paired' }),
    'skills.discover',
    expect.anything(),
    expect.anything()
  )
  unmount()
})

it.each(['worktree', 'folder'] as const)(
  'settles direct SSH %s setup as unavailable and resumes discovery when a server serves it',
  async (kind) => {
    const discover = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        platform: { get: () => ({ platform: 'linux' }) },
        skills: { discover }
      }
    })
    const worktree = makeWorktree({ id: 'repo::/ssh', repoId: 'repo', hostId: 'ssh:box' })
    const workspaceId = kind === 'worktree' ? worktree.id : 'folder:ssh'
    const settings = getDefaultSettings('/tmp')
    const providerKey = getProviderRuntimeContextKey(settings)
    useAppStore.setState({
      activeRepoId: 'repo',
      activeWorktreeId: workspaceId,
      activeWorkspaceExecutionHostId: 'ssh:box',
      worktreesByRepo: {},
      folderWorkspaces: [],
      projects: [],
      repos: [],
      projectGroups: [],
      restoredRuntimeHostIdByWorkspaceSessionKey: {},
      runtimeEnvironmentCatalogSettled: true,
      runtimeEnvironments: [],
      runtimeStatusByEnvironmentId: new Map(),
      settings,
      preflightStatusChecked: true,
      preflightStatusLoading: false,
      linearStatus: { connected: true, viewer: null },
      linearStatusChecked: true,
      linearStatusContextKey: providerKey,
      jiraStatusChecked: true,
      jiraStatusContextKey: providerKey,
      setupGuideBrowserMilestoneMigrated: true,
      setupGuideBrowserMilestoneLegacyComplete: false
    })
    useAppStore.setState({
      preflightStatusContextKey: localPreflightContextKey(
        getLocalPreflightContext(useAppStore.getState())
      )
    })
    const { result, unmount } = renderHook(() => ({
      capabilities: useAgentCapabilitySetupStatus(),
      progress: useSetupGuideProgress(true, false, false)
    }))
    expect(isAgentCapabilityReadinessChecking(result.current.capabilities.readiness)).toBe(true)
    expect(result.current.progress.ready).toBe(false)

    act(() => {
      useAppStore.setState(
        kind === 'worktree'
          ? { worktreesByRepo: { repo: [worktree] } }
          : {
              folderWorkspaces: [makeFolderWorkspace({ id: 'ssh', executionHostId: 'ssh:box' })]
            }
      )
    })
    await waitFor(() => expect(result.current.progress.ready).toBe(true))
    expect(isAgentCapabilityReadinessChecking(result.current.capabilities.readiness)).toBe(false)
    for (const capability of ['browserUse', 'computerUse', 'orchestration'] as const) {
      expect(result.current.capabilities.installStatus[capability]).toEqual({
        label: 'Requires an Orca server',
        tone: 'unavailable'
      })
    }
    expect(result.current.progress.stepDone['agent-capabilities']).toBe(false)
    act(() => window.dispatchEvent(new Event('focus')))
    expect(discover).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()

    let finishScan!: (result: { skills: []; sources: []; scannedAt: number }) => void
    const scan = new Promise((resolve) => {
      finishScan = resolve
    })
    rpc.mockReturnValue(scan)
    act(() => {
      useAppStore.setState({
        runtimeEnvironments: [
          {
            id: 'server',
            name: 'Server',
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: null,
            runtimeId: null,
            endpoints: [],
            preferredEndpointId: 'endpoint',
            orcadDeployment: {
              sshTargetId: 'box',
              sshTargetGeneration: 1,
              localPort: 1234,
              remotePort: 1234
            }
          }
        ]
      })
    })
    expect(result.current.progress.ready).toBe(false)
    expect(result.current.capabilities.installStatus.browserUse.tone).toBe('checking')
    expect(rpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'server' },
      'skills.discover',
      expect.anything(),
      expect.anything()
    )
    await act(async () => finishScan({ skills: [], sources: [], scannedAt: 1 }))
    expect(result.current.progress.ready).toBe(true)
    expect(result.current.capabilities.installStatus.browserUse.tone).toBe('pending')
    expect(discover).not.toHaveBeenCalled()
    unmount()
  }
)
