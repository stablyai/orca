// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { getDefaultSettings } from '../../../shared/constants'
import {
  loadWindowsTerminalCapabilities,
  resetWindowsTerminalCapabilitiesForTests
} from '@/lib/windows-terminal-capabilities'
import { useAppStore } from '@/store'
import {
  hasLocalSkillRuntimeAuthority,
  shouldUseLocalSkillFreshness,
  useActiveProjectSkillRuntime
} from './useActiveProjectSkillRuntime'

function setPlatform(platform: NodeJS.Platform): void {
  ;(window as unknown as { api: unknown }).api = {
    platform: { get: () => ({ platform }) },
    wsl: { isAvailable: async () => true, listDistros: async () => ['Ubuntu'] },
    pwsh: { isAvailable: async () => true },
    gitBash: { isAvailable: async () => false },
    runtime: { getStatus: async () => ({ hostPlatform: platform }) }
  }
}

function setWindowsShell(terminalWindowsShell: string): void {
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), terminalWindowsShell }
  })
}

function setGlobalWslDefault(distro: string | null): void {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/tmp'),
      localWindowsRuntimeDefault: { kind: 'wsl', distro }
    }
  })
}

describe('useActiveProjectSkillRuntime', () => {
  beforeEach(async () => {
    setPlatform('win32')
    setWindowsShell('git-bash')
    useAppStore.setState({ runtimeEnvironmentCatalogSettled: true, runtimeEnvironments: [] })
    // Why: a settled capability probe is what separates a resolved WSL runtime
    // from a repair-required one; both map to the same agentRuntime shape.
    await loadWindowsTerminalCapabilities()
  })

  afterEach(() => {
    resetWindowsTerminalCapabilitiesForTests()
    delete (window as unknown as { api?: unknown }).api
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
      label: 'WSL Ubuntu'
    })
    expect(result.current.projectRuntime?.status).toBe('resolved')
    expect(result.current.installDisabledReason).toBeNull()
  })

  it('ignores a windows-host global default so skill discovery keeps no target', () => {
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.projectRuntime).toBeUndefined()
    expect(result.current.discoveryTarget).toBeUndefined()
  })

  it('lets an active local project override the global default', () => {
    setGlobalWslDefault('Ubuntu')
    useAppStore.setState({
      activeRepoId: 'repo-1',
      repos: [{ id: 'repo-1', path: 'C:\\repo', displayName: 'r', badgeColor: 'b', addedAt: 1 }],
      projects: [{ id: 'repo-1', localWindowsRuntimePreference: { kind: 'windows-host' } }] as never
    })
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.agentRuntime).toEqual({ runtime: 'host', label: 'Windows' })
    useAppStore.setState({ activeRepoId: null, repos: [], projects: [] })
  })

  it('keeps the global WSL default while an SSH project is active', () => {
    setGlobalWslDefault('Ubuntu')
    useAppStore.setState({
      activeRepoId: 'repo-ssh',
      repos: [
        {
          id: 'repo-ssh',
          path: '/home/alice/repo',
          displayName: 'r',
          badgeColor: 'b',
          addedAt: 1,
          connectionId: 'builder',
          executionHostId: 'ssh:builder'
        }
      ]
    })
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.agentRuntime).toEqual({
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      label: 'WSL Ubuntu'
    })
    expect(result.current.projectRuntime?.status).toBe('resolved')
    expect(result.current.installDisabledReason).toBeNull()
    useAppStore.setState({ activeRepoId: null, repos: [] })
  })

  it('does not block skill install when the global WSL default needs a distro inside an SSH project', () => {
    setGlobalWslDefault(null)
    useAppStore.setState({
      activeRepoId: 'repo-ssh',
      repos: [
        {
          id: 'repo-ssh',
          path: '/home/alice/repo',
          displayName: 'r',
          badgeColor: 'b',
          addedAt: 1,
          connectionId: 'builder',
          executionHostId: 'ssh:builder'
        }
      ]
    })
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    // Why: the repair prompt names "this project", but an SSH project cannot own
    // the local runtime; keep the host fallback instead of a dead-end message.
    expect(result.current.projectRuntime).toBeUndefined()
    expect(result.current.installDisabledReason).toBeNull()
    useAppStore.setState({ activeRepoId: null, repos: [] })
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

    expect(result.current.agentRuntime).toBeUndefined()
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
