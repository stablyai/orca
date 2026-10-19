import { describe, expect, it } from 'vitest'
import {
  getFocusedDropRuntimeId,
  getSidebarProjectDropAffordance,
  isSidebarProjectDropRefusedByFocus,
  resolveSidebarProjectDropPath,
  routeSidebarProjectDrop
} from './sidebar-project-drop'
import { wslDistroWindowsPathAccess } from '../../../../shared/windows-path-access'

describe('resolveSidebarProjectDropPath', () => {
  it('accepts exactly one dropped path', () => {
    expect(resolveSidebarProjectDropPath(['/Users/alice/repo'])).toEqual({
      status: 'ready',
      path: '/Users/alice/repo'
    })
  })

  it('rejects empty and multi-path drops before routing', () => {
    expect(resolveSidebarProjectDropPath([])).toEqual({ status: 'empty' })
    expect(resolveSidebarProjectDropPath(['/repo/a', '/repo/b'])).toEqual({
      status: 'multiple',
      count: 2
    })
  })
})

describe('getFocusedDropRuntimeId', () => {
  it('distinguishes local runtime from active server runtime', () => {
    expect(getFocusedDropRuntimeId(null)).toBeNull()
    expect(getFocusedDropRuntimeId({ activeRuntimeEnvironmentId: '   ' })).toBeNull()
    expect(getFocusedDropRuntimeId({ activeRuntimeEnvironmentId: 'server-1' })).toBe('server-1')
  })
})

describe('routeSidebarProjectDrop', () => {
  const wslHosts = [
    { environmentId: 'wsl:Ubuntu', access: wslDistroWindowsPathAccess('Ubuntu') },
    { environmentId: 'wsl:Debian', access: wslDistroWindowsPathAccess('Debian') }
  ]

  it('gives a folder inside a WSL host distro to that host, whatever is focused', () => {
    for (const focusedRuntimeId of [null, 'wsl:Debian', 'paired-server']) {
      expect(
        routeSidebarProjectDrop({
          path: '\\\\wsl.localhost\\ubuntu\\home\\me\\my repo',
          focusedRuntimeId,
          wslHosts
        })
      ).toEqual({ kind: 'wsl-host', hostId: 'runtime:wsl%3AUbuntu', linuxPath: '/home/me/my repo' })
    }
    expect(
      routeSidebarProjectDrop({
        path: '\\\\wsl$\\Debian\\srv\\app',
        focusedRuntimeId: null,
        wslHosts
      })
    ).toEqual({ kind: 'wsl-host', hostId: 'runtime:wsl%3ADebian', linuxPath: '/srv/app' })
  })

  it('keeps a drive folder on this computer and never routes it to a WSL host', () => {
    expect(
      routeSidebarProjectDrop({ path: 'C:\\src\\app', focusedRuntimeId: null, wslHosts })
    ).toEqual({ kind: 'local', path: 'C:\\src\\app' })
    expect(
      routeSidebarProjectDrop({ path: 'C:\\src\\app', focusedRuntimeId: 'wsl:Ubuntu', wslHosts })
    ).toEqual({ kind: 'windows-drive-on-wsl-host', distro: 'Ubuntu' })
  })

  it('keeps refusing other drops while a server is focused', () => {
    expect(
      routeSidebarProjectDrop({ path: 'C:\\src', focusedRuntimeId: 'paired-server', wslHosts })
    ).toEqual({ kind: 'runtime-focused' })
    expect(
      routeSidebarProjectDrop({
        path: '\\\\wsl.localhost\\Arch\\home',
        focusedRuntimeId: 'wsl:Ubuntu',
        wslHosts
      })
    ).toEqual({ kind: 'runtime-focused' })
    expect(
      routeSidebarProjectDrop({ path: '/Users/me/app', focusedRuntimeId: 'server', wslHosts: [] })
    ).toEqual({ kind: 'runtime-focused' })
  })

  it('accepts the drag over a focused server only when a WSL host could own the folder', () => {
    expect(isSidebarProjectDropRefusedByFocus(null, [])).toBe(false)
    expect(isSidebarProjectDropRefusedByFocus('server', [])).toBe(true)
    expect(isSidebarProjectDropRefusedByFocus('server', wslHosts)).toBe(false)
  })
})

describe('getSidebarProjectDropAffordance', () => {
  it('hides when the sidebar is not in a drop interaction', () => {
    expect(
      getSidebarProjectDropAffordance({
        isDragOver: false,
        isHandlingDrop: false,
        remoteRuntimeActive: false
      })
    ).toEqual({ visible: false })
  })

  it('shows ready, busy, and blocked states', () => {
    expect(
      getSidebarProjectDropAffordance({
        isDragOver: true,
        isHandlingDrop: false,
        remoteRuntimeActive: false
      })
    ).toMatchObject({ visible: true, tone: 'ready' })

    expect(
      getSidebarProjectDropAffordance({
        isDragOver: false,
        isHandlingDrop: true,
        remoteRuntimeActive: false
      })
    ).toMatchObject({ visible: true, tone: 'busy' })

    expect(
      getSidebarProjectDropAffordance({
        isDragOver: true,
        isHandlingDrop: false,
        remoteRuntimeActive: true
      })
    ).toMatchObject({ visible: true, tone: 'blocked' })

    expect(
      getSidebarProjectDropAffordance({
        isDragOver: true,
        isHandlingDrop: false,
        remoteRuntimeActive: false,
        wslDropsOnly: true
      })
    ).toMatchObject({ visible: true, tone: 'ready', label: 'Drop a WSL folder to add project' })
  })
})
