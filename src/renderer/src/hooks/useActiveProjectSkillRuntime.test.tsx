// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../shared/constants'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import {
  hasLocalSkillRuntimeAuthority,
  shouldUseSkillFreshness,
  useActiveProjectSkillRuntime
} from './useActiveProjectSkillRuntime'

function setPlatform(platform: NodeJS.Platform): void {
  ;(window as unknown as { api: unknown }).api = {
    platform: { get: () => ({ platform }) }
  }
}

function setWindowsShell(terminalWindowsShell: string): void {
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), terminalWindowsShell }
  })
}

function setGlobalWslDefault(distro: string): void {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/tmp'),
      localWindowsRuntimeDefault: { kind: 'wsl', distro }
    }
  })
}

describe('useActiveProjectSkillRuntime', () => {
  beforeEach(() => {
    setPlatform('win32')
    setWindowsShell('git-bash')
    useAppStore.setState({
      activeRepoId: null,
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      endpointProjects: [],
      repos: [],
      worktreesByRepo: {},
      folderWorkspaces: [],
      projectGroups: [],
      restoredRuntimeHostIdByWorkspaceSessionKey: {},
      runtimeEnvironmentCatalogSettled: true,
      runtimeEnvironments: []
    })
  })

  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  it('adopts the global WSL default when no project is active', () => {
    setGlobalWslDefault('Ubuntu')
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.agentRuntime).toEqual({
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      label: 'WSL Ubuntu'
    })
    expect(result.current.bundledSkillTarget).toBeNull()
    expect(result.current.discoveryRuntimeTarget).toEqual({ kind: 'local' })
    expect(result.current.canUseSkillFreshness).toBe(false)
  })

  it('ignores a windows-host global default so skill discovery keeps no target', () => {
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.projectRuntime).toBeUndefined()
    expect(result.current.discoveryTarget).toBeUndefined()
  })

  it('does not adopt the global default once a project is active', () => {
    setGlobalWslDefault('Ubuntu')
    useAppStore.setState({ activeRepoId: 'repo-1' })
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.agentRuntime).toBeUndefined()
    useAppStore.setState({ activeRepoId: null })
  })

  it('does not inject the local WSL runtime into a remote environment', () => {
    setGlobalWslDefault('Ubuntu')
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        activeRuntimeEnvironmentId: 'ssh-production'
      },
      runtimeEnvironments: [{ id: 'ssh-production' }] as never
    })
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.agentRuntime).toBeUndefined()
  })

  it.each<{ name: string; workspaceId: string; hostId: ExecutionHostId }>([
    { name: 'SSH worktree', workspaceId: 'repo::/remote/ssh', hostId: 'ssh:box' },
    { name: 'paired worktree', workspaceId: 'repo::/remote/paired', hostId: 'runtime:paired' },
    { name: 'folder workspace', workspaceId: 'folder:restored', hostId: 'runtime:paired' }
  ])(
    'keeps a restored $name unresolved while owner rows are missing',
    ({ workspaceId, hostId }) => {
      useAppStore.setState({
        activeRepoId: 'repo',
        activeWorktreeId: workspaceId,
        activeWorkspaceExecutionHostId: hostId
      })

      const { result } = renderHook(() => useActiveProjectSkillRuntime())

      expect(result.current.bundledSkillTarget).toBeNull()
      expect(result.current.discoveryRuntimeTarget).toBeNull()
      expect(result.current.canUseSkillFreshness).toBe(false)
    }
  )

  it('keeps a local target when no workspace is active', () => {
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.bundledSkillTarget).toEqual({ kind: 'local' })
    expect(result.current.canUseSkillFreshness).toBe(true)
  })

  it('keeps a proven local target for floating terminals', () => {
    useAppStore.setState({ activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID })
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.bundledSkillTarget).toEqual({ kind: 'local' })
    expect(result.current.canUseSkillFreshness).toBe(true)
  })

  it('keeps proven local workspace ownership ahead of a focused paired transport', () => {
    const worktree = makeWorktree({ id: 'repo::/local', repoId: 'repo', hostId: 'local' })
    useAppStore.setState({
      activeWorktreeId: worktree.id,
      activeWorkspaceExecutionHostId: 'local',
      worktreesByRepo: { repo: [worktree] },
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
    const { result } = renderHook(() => useActiveProjectSkillRuntime())
    expect(result.current.bundledSkillTarget).toEqual({ kind: 'local' })
    expect(result.current.discoveryRuntimeTarget).toEqual({ kind: 'local' })
  })

  it('limits freshness pills to this machine and paired hosts', () => {
    expect(shouldUseSkillFreshness({ kind: 'local' }, undefined)).toBe(true)
    expect(shouldUseSkillFreshness({ kind: 'local' }, { runtime: 'host', label: 'Host' })).toBe(
      true
    )
    expect(shouldUseSkillFreshness({ kind: 'local' }, { runtime: 'wsl', label: 'WSL' })).toBe(false)
    expect(
      shouldUseSkillFreshness({ kind: 'environment', environmentId: 'ssh-production' }, undefined)
    ).toBe(true)
    expect(shouldUseSkillFreshness(null, undefined)).toBe(false)
  })

  it('limits the no-project Windows fallback to local runtime authority', () => {
    expect(hasLocalSkillRuntimeAuthority({ kind: 'local' })).toBe(true)
    expect(
      hasLocalSkillRuntimeAuthority({ kind: 'environment', environmentId: 'ssh-production' })
    ).toBe(false)
    expect(hasLocalSkillRuntimeAuthority(null)).toBe(false)
  })
})
