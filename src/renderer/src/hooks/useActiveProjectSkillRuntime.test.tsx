// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { getDefaultSettings } from '../../../shared/constants'
import { useAppStore } from '@/store'
import { buildSkillCommandForRuntime } from '@/components/settings/CliSkillRuntimeSetup'
import {
  hasLocalSkillRuntimeAuthority,
  resolveSkillExecutionHostPlatform,
  shouldUseLocalSkillFreshness,
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
      projects: [],
      repos: [],
      runtimeEnvironmentCatalogSettled: true,
      runtimeEnvironments: [],
      runtimeStatusByEnvironmentId: new Map(),
      worktreesByRepo: {}
    })
  })

  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
    delete (window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
  })

  // Why: with no local project runtime, buildSkillCommandForRuntime still emits the
  // Windows host cmd.exe wrapper, which Git Bash would mangle into MSYS paths.
  it('still overrides a POSIX-family Windows shell when no project runtime resolves', () => {
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.projectRuntime).toBeUndefined()
    expect(result.current.terminalShellOverride).toBe('powershell.exe')
  })

  it('adopts the global WSL default when no project is active', () => {
    setGlobalWslDefault('Ubuntu')
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.agentRuntime).toEqual({
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      hostPlatform: 'win32',
      runtimeEnvironmentId: null,
      runtimeOwnershipResolved: true,
      label: 'WSL Ubuntu'
    })
  })

  it('ignores a windows-host global default so skill discovery keeps no target', () => {
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.projectRuntime).toBeUndefined()
    expect(result.current.discoveryTarget).toBeUndefined()
  })

  it('uses a remote Linux host instead of the Windows viewer platform', () => {
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        activeRuntimeEnvironmentId: 'linux-host'
      },
      runtimeEnvironments: [{ id: 'linux-host' }] as never,
      runtimeStatusByEnvironmentId: new Map([
        ['linux-host', { checkedAt: 1, status: { hostPlatform: 'linux' } as never }]
      ])
    })
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.agentRuntime).toMatchObject({
      runtime: 'host',
      hostPlatform: 'linux',
      runtimeEnvironmentId: 'linux-host'
    })
    expect(result.current.terminalShellOverride).toBeUndefined()
  })

  it('uses a remote Windows host instead of the non-Windows viewer platform', () => {
    setPlatform('darwin')
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        activeRuntimeEnvironmentId: 'windows-host'
      },
      runtimeEnvironments: [{ id: 'windows-host' }] as never,
      runtimeStatusByEnvironmentId: new Map([
        ['windows-host', { checkedAt: 1, status: { hostPlatform: 'win32' } as never }]
      ])
    })
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.agentRuntime).toMatchObject({
      runtime: 'host',
      hostPlatform: 'win32',
      runtimeEnvironmentId: 'windows-host'
    })
  })

  it('keeps a legacy Windows host shell neutral instead of borrowing viewer settings', () => {
    setWindowsShell('git-bash')
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        activeRuntimeEnvironmentId: 'windows-host'
      },
      runtimeEnvironments: [{ id: 'windows-host' }] as never,
      runtimeStatusByEnvironmentId: new Map([
        ['windows-host', { checkedAt: 1, status: { hostPlatform: 'win32' } as never }]
      ])
    })
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.agentRuntime).toHaveProperty('terminalWindowsShell', undefined)
    expect(
      buildSkillCommandForRuntime('npx skills add owner/repo', result.current.agentRuntime)
    ).toBe('npx skills add owner/repo')
  })

  it('keeps an old remote host platform unknown instead of borrowing the viewer', () => {
    setPlatform('darwin')
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        activeRuntimeEnvironmentId: 'old-host'
      },
      runtimeEnvironments: [{ id: 'old-host' }] as never,
      runtimeStatusByEnvironmentId: new Map([['old-host', { checkedAt: 1, status: {} as never }]])
    })
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.agentRuntime).toMatchObject({ runtime: 'host' })
    expect(result.current.agentRuntime?.hostPlatform).toBeUndefined()
    expect(result.current.executionHostPlatform).toBeUndefined()
  })

  it('isolates the platform to the exact selected remote host', () => {
    expect(
      resolveSkillExecutionHostPlatform({
        viewerPlatform: 'darwin',
        runtimeTarget: { kind: 'environment', environmentId: 'linux-host' },
        executionHostPlatform: 'linux',
        isWebClient: false
      })
    ).toBe('linux')
    expect(
      resolveSkillExecutionHostPlatform({
        viewerPlatform: 'darwin',
        runtimeTarget: { kind: 'environment', environmentId: 'windows-host' },
        executionHostPlatform: 'win32',
        isWebClient: false
      })
    ).toBe('win32')
    expect(
      resolveSkillExecutionHostPlatform({
        viewerPlatform: 'darwin',
        runtimeTarget: { kind: 'environment', environmentId: 'old-host' },
        isWebClient: false
      })
    ).toBeUndefined()
  })

  it('keeps local desktop behavior on the viewer platform', () => {
    expect(
      resolveSkillExecutionHostPlatform({
        viewerPlatform: 'darwin',
        runtimeTarget: { kind: 'local' },
        executionHostPlatform: 'linux',
        isWebClient: false
      })
    ).toBe('darwin')
  })

  it('uses the paired web host platform instead of the viewer platform', () => {
    expect(
      resolveSkillExecutionHostPlatform({
        viewerPlatform: 'win32',
        runtimeTarget: { kind: 'local' },
        executionHostPlatform: 'linux',
        isWebClient: true
      })
    ).toBe('linux')
    expect(
      resolveSkillExecutionHostPlatform({
        viewerPlatform: 'win32',
        runtimeTarget: null,
        executionHostPlatform: 'linux',
        isWebClient: true
      })
    ).toBeUndefined()
  })

  it('keeps unresolved desktop ownership platform-neutral', () => {
    expect(
      resolveSkillExecutionHostPlatform({
        viewerPlatform: 'darwin',
        runtimeTarget: null,
        executionHostPlatform: 'linux',
        isWebClient: false
      })
    ).toBeUndefined()
  })

  it('publishes explicit neutral runtime metadata while ownership is unresolved', () => {
    useAppStore.setState({ runtimeEnvironmentCatalogSettled: false })
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.agentRuntime).toEqual({
      runtime: 'host',
      hostPlatform: undefined,
      terminalWindowsShell: undefined,
      runtimeOwnershipResolved: false,
      label: 'This device'
    })
    expect(
      buildSkillCommandForRuntime('npx skills add owner/repo', result.current.agentRuntime)
    ).toBe('npx skills add owner/repo')
  })

  it('does not borrow a saved web runtime before ownership resolves', () => {
    ;(window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    useAppStore.setState({
      runtimeEnvironmentCatalogSettled: false,
      runtimeEnvironments: [{ id: 'stale-host' }] as never,
      runtimeStatusByEnvironmentId: new Map([
        ['stale-host', { checkedAt: 1, status: { hostPlatform: 'linux' } as never }]
      ])
    })

    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.executionHostPlatform).toBeUndefined()
    expect(result.current.agentRuntime).toMatchObject({ runtimeOwnershipResolved: false })
    expect(result.current.agentRuntime).not.toHaveProperty('runtimeEnvironmentId')
  })

  it('does not borrow viewer WSL defaults for a paired Windows host', () => {
    ;(window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    setGlobalWslDefault('Ubuntu')
    setPlatform('darwin')
    useAppStore.setState({
      activeRepoId: 'repo-1',
      activeWorktreeId: 'worktree-1',
      projects: [] as never,
      repos: [
        {
          id: 'repo-1',
          path: 'C:\\repo',
          executionHostId: 'runtime:windows-host'
        }
      ] as never,
      settings: {
        ...useAppStore.getState().settings!,
        activeRuntimeEnvironmentId: 'windows-host'
      },
      runtimeEnvironments: [{ id: 'windows-host' }] as never,
      runtimeStatusByEnvironmentId: new Map([
        ['windows-host', { checkedAt: 1, status: { hostPlatform: 'win32' } as never }]
      ]),
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'worktree-1',
            repoId: 'repo-1',
            path: 'C:\\repo',
            hostId: 'runtime:windows-host'
          }
        ]
      } as never
    })
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.agentRuntime).toMatchObject({ runtime: 'host', hostPlatform: 'win32' })
  })

  it('keeps a disconnected remote host platform unknown', () => {
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        activeRuntimeEnvironmentId: 'offline-host'
      },
      runtimeEnvironments: [{ id: 'offline-host' }] as never,
      runtimeStatusByEnvironmentId: new Map([
        ['offline-host', { checkedAt: 1, status: null } as never]
      ])
    })
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.agentRuntime).toMatchObject({ runtime: 'host' })
    expect(result.current.agentRuntime?.hostPlatform).toBeUndefined()
  })

  it('does not adopt the global default once a project is active', () => {
    setGlobalWslDefault('Ubuntu')
    useAppStore.setState({ activeRepoId: 'repo-1' })
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.agentRuntime).toMatchObject({
      runtime: 'host',
      runtimeEnvironmentId: null
    })
    useAppStore.setState({ activeRepoId: null })
  })

  it('does not inject the local WSL runtime or shell into a remote environment', () => {
    setGlobalWslDefault('Ubuntu')
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        activeRuntimeEnvironmentId: 'ssh-production'
      },
      runtimeEnvironments: [{ id: 'ssh-production' }] as never
    })
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.agentRuntime).toMatchObject({ runtime: 'host' })
    expect(result.current.agentRuntime?.hostPlatform).toBeUndefined()
    expect(result.current.terminalShellOverride).toBeUndefined()
  })

  it('leaves the shell alone on non-Windows hosts', () => {
    setPlatform('darwin')
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.terminalShellOverride).toBeUndefined()
  })

  it('limits local freshness to resolved host runtimes', () => {
    expect(shouldUseLocalSkillFreshness({ kind: 'local' }, undefined)).toBe(true)
    expect(
      shouldUseLocalSkillFreshness({ kind: 'local' }, { runtime: 'host', label: 'Host' })
    ).toBe(true)
    expect(shouldUseLocalSkillFreshness({ kind: 'local' }, { runtime: 'wsl', label: 'WSL' })).toBe(
      false
    )
    expect(
      shouldUseLocalSkillFreshness(
        { kind: 'environment', environmentId: 'ssh-production' },
        undefined
      )
    ).toBe(false)
    expect(shouldUseLocalSkillFreshness(null, undefined)).toBe(false)
  })

  it('limits the no-project Windows fallback to local runtime authority', () => {
    expect(hasLocalSkillRuntimeAuthority({ kind: 'local' })).toBe(true)
    expect(
      hasLocalSkillRuntimeAuthority({ kind: 'environment', environmentId: 'ssh-production' })
    ).toBe(false)
    expect(hasLocalSkillRuntimeAuthority(null)).toBe(false)
  })
})
