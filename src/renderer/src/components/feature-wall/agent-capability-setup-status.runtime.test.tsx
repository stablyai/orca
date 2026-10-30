// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { resetSkillDiscoveryCacheForTests } from '@/hooks/installed-agent-skill-discovery'
import { useAgentCapabilitySetupStatus } from './agent-capability-setup-status'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))

afterEach(() => {
  resetSkillDiscoveryCacheForTests()
  rpc.mockReset()
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
  Reflect.deleteProperty(window, 'api')
})
