import { describe, expect, it } from 'vitest'
import { routeSidebarProjectDrop } from './sidebar-project-drop'
import { wslDistroWindowsPathAccess } from '../../../../../../shared/windows-path-access'

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
    ).toEqual({ kind: 'windows-drive-on-wsl-host', distro: 'Ubuntu', path: 'C:\\src\\app' })
  })

  it.each([
    '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\src\\app',
    // Any distro's drvfs mount, as the picker treats it.
    '\\\\wsl$\\Arch\\mnt\\c\\src\\app',
    '\\\\?\\UNC\\wsl.localhost\\Arch\\mnt\\c\\src\\app'
  ])('treats a drvfs drop %j as the Windows drive folder it is', (path) => {
    expect(routeSidebarProjectDrop({ path, focusedRuntimeId: null, wslHosts })).toEqual({
      kind: 'local',
      path: 'C:\\src\\app'
    })
    expect(routeSidebarProjectDrop({ path, focusedRuntimeId: 'wsl:Ubuntu', wslHosts })).toEqual({
      kind: 'windows-drive-on-wsl-host',
      distro: 'Ubuntu',
      path: 'C:\\src\\app'
    })
  })
})
