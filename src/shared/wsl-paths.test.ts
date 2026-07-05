import { describe, expect, it } from 'vitest'
import { isWslUncPath, parseWslUncPath, toLinuxPath, toWindowsWslPath } from './wsl-paths'

describe('wsl path helpers', () => {
  it('parses modern and legacy WSL UNC paths without platform checks', () => {
    expect(parseWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo')).toEqual({
      distro: 'Ubuntu',
      linuxPath: '/home/jin/repo'
    })
    expect(parseWslUncPath('\\\\wsl$\\Debian\\home\\jin')).toEqual({
      distro: 'Debian',
      linuxPath: '/home/jin'
    })
  })

  it('rejects ordinary Windows and POSIX paths', () => {
    expect(isWslUncPath('C:\\Users\\jin\\repo')).toBe(false)
    expect(isWslUncPath('/home/jin/repo')).toBe(false)
  })

  it('converts Windows paths to Linux paths for WSL commands', () => {
    expect(toLinuxPath('C:\\Users\\jin\\repo')).toBe('/mnt/c/Users/jin/repo')
    expect(toLinuxPath('D:/work/repo')).toBe('/mnt/d/work/repo')
    expect(toLinuxPath('\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo')).toBe('/home/jin/repo')
    expect(toLinuxPath('/home/jin/repo')).toBe('/home/jin/repo')
  })

  it('converts Linux paths back to Windows-visible paths', () => {
    expect(toWindowsWslPath('/mnt/c/Users/jin/repo', 'Ubuntu')).toBe('C:\\Users\\jin\\repo')
    expect(toWindowsWslPath('/mnt/C/Users/jin/repo', 'Ubuntu')).toBe('C:\\Users\\jin\\repo')
    expect(toWindowsWslPath('/mnt/c', 'Ubuntu')).toBe('C:\\')
    expect(toWindowsWslPath('/home/jin/repo', 'Ubuntu')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'
    )
  })
})
