// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { getDefaultSettings } from '../../../shared/constants'
import { useAppStore } from '@/store'
import {
  hasLocalSkillRuntimeAuthority,
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
    useAppStore.setState({ runtimeEnvironmentCatalogSettled: true, runtimeEnvironments: [] })
  })

  afterEach(() => {
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
