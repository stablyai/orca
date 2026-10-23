import { describe, expect, it } from 'vitest'
import {
  classifyRejectedWindowsPath,
  windowsPathAccess,
  wslDistroWindowsPathAccess,
  type WindowsPathAccessContext
} from './windows-path-access'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from './execution-host'

const WSL_HOST = toRuntimeExecutionHostId('wsl:Ubuntu')
const context = (platform: NodeJS.Platform | null = 'win32'): WindowsPathAccessContext => ({
  platform,
  wslDistroForEnvironment: (environmentId) => (environmentId === 'wsl:Ubuntu' ? 'Ubuntu' : null)
})

describe('windowsPathAccess', () => {
  it('resolves only a WSL host owner on Windows', () => {
    expect(windowsPathAccess(WSL_HOST, context())?.wslDistro).toBe('Ubuntu')
    expect(windowsPathAccess('local', context())).toBeNull()
    expect(windowsPathAccess(toSshExecutionHostId('box'), context())).toBeNull()
    expect(windowsPathAccess(toRuntimeExecutionHostId('paired-server'), context())).toBeNull()
    expect(windowsPathAccess('runtime:unresolved-owner', context())).toBeNull()
    expect(windowsPathAccess(null, context())).toBeNull()
  })

  it('is null off Windows, even for a WSL host', () => {
    expect(windowsPathAccess(WSL_HOST, context('darwin'))).toBeNull()
    expect(windowsPathAccess(WSL_HOST, context('linux'))).toBeNull()
    expect(windowsPathAccess(WSL_HOST, context(null))).toBeNull()
  })
})

describe('wslDistroWindowsPathAccess', () => {
  const access = wslDistroWindowsPathAccess('Ubuntu')

  it('spells Linux paths as \\\\wsl.localhost paths in the canonical distro casing', () => {
    expect(access.toWindows('/home/me/my repo')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\me\\my repo'
    )
    expect(access.toWindows('/home/me/プロジェクト/')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\me\\プロジェクト'
    )
    expect(access.toWindows('/')).toBe('\\\\wsl.localhost\\Ubuntu\\')
    expect(access.toWindows('/mnt/c/src')).toBe('\\\\wsl.localhost\\Ubuntu\\mnt\\c\\src')
  })

  it('refuses paths Windows would read differently', () => {
    expect(access.toWindows('relative/path')).toBeNull()
    expect(access.toWindows('//server/share')).toBeNull()
    expect(access.toWindows('/home/me/../root')).toBeNull()
    expect(access.toWindows('/home/me/a\\b')).toBeNull()
    expect(access.toWindows('C:\\Users\\me')).toBeNull()
  })

  it('reads its own distro case-insensitively, through both share prefixes', () => {
    expect(access.fromWindows('\\\\wsl.localhost\\ubuntu\\home\\me')).toBe('/home/me')
    expect(access.fromWindows('\\\\WSL.LOCALHOST\\UBUNTU\\home\\Me\\')).toBe('/home/Me')
    expect(access.fromWindows('\\\\wsl$\\Ubuntu\\home\\me\\my repo')).toBe('/home/me/my repo')
    expect(access.fromWindows('//wsl.localhost/Ubuntu/home/me/プロジェクト')).toBe(
      '/home/me/プロジェクト'
    )
    expect(access.fromWindows('\\\\?\\UNC\\wsl.localhost\\Ubuntu\\srv')).toBe('/srv')
    expect(access.fromWindows('\\\\wsl.localhost\\Ubuntu')).toBe('/')
  })

  it('refuses drive paths, other distros and other shares', () => {
    expect(access.fromWindows('C:\\Users\\me\\repo')).toBeNull()
    expect(access.fromWindows('\\\\?\\C:\\Users\\me')).toBeNull()
    expect(access.fromWindows('\\\\wsl.localhost\\Debian\\home\\me')).toBeNull()
    expect(access.fromWindows('\\\\wsl.localhost\\Ubuntu-22.04\\home\\me')).toBeNull()
    expect(access.fromWindows('\\\\fileserver\\share\\repo')).toBeNull()
    expect(access.fromWindows('/home/me')).toBeNull()
  })
})

describe('classifyRejectedWindowsPath', () => {
  it('names why a path was refused', () => {
    expect(classifyRejectedWindowsPath('C:\\Users\\me')).toEqual({ kind: 'windows-drive' })
    expect(classifyRejectedWindowsPath('d:/src')).toEqual({ kind: 'windows-drive' })
    expect(classifyRejectedWindowsPath('\\\\?\\C:\\src')).toEqual({ kind: 'windows-drive' })
    expect(classifyRejectedWindowsPath('\\\\wsl$\\Debian\\home')).toEqual({
      kind: 'other-distro',
      distro: 'Debian'
    })
    expect(classifyRejectedWindowsPath('\\\\fileserver\\share')).toEqual({ kind: 'not-wsl' })
  })
})
