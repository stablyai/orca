import { describe, expect, it } from 'vitest'
import { isWslUncPath, parseWslUncPath } from './wsl-paths'

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
})
