import { describe, expect, it } from 'vitest'
import { buildWslPickerDefaultPath, getWslPickerDefaultDistro } from './wsl-picker-default-path'

describe('getWslPickerDefaultDistro', () => {
  it('returns the distro when WSL is the default runtime on Windows', () => {
    expect(getWslPickerDefaultDistro({ kind: 'wsl', distro: 'Ubuntu' }, 'win32')).toBe('Ubuntu')
  })

  it('returns null when the default runtime is the Windows host', () => {
    expect(getWslPickerDefaultDistro({ kind: 'windows-host' }, 'win32')).toBeNull()
  })

  it('returns null when the WSL default has no concrete distro selected', () => {
    expect(getWslPickerDefaultDistro({ kind: 'wsl', distro: null }, 'win32')).toBeNull()
  })

  it('never targets WSL off Windows even when a WSL default is persisted', () => {
    expect(getWslPickerDefaultDistro({ kind: 'wsl', distro: 'Ubuntu' }, 'darwin')).toBeNull()
    expect(getWslPickerDefaultDistro({ kind: 'wsl', distro: 'Ubuntu' }, 'linux')).toBeNull()
  })

  it('treats malformed persisted settings as the Windows host default', () => {
    expect(getWslPickerDefaultDistro(undefined, 'win32')).toBeNull()
    expect(getWslPickerDefaultDistro({}, 'win32')).toBeNull()
    expect(getWslPickerDefaultDistro('wsl', 'win32')).toBeNull()
  })
})

describe('buildWslPickerDefaultPath', () => {
  it('prefers the resolved WSL home UNC path', () => {
    expect(buildWslPickerDefaultPath('Ubuntu', String.raw`\\wsl.localhost\Ubuntu\home\alice`)).toBe(
      String.raw`\\wsl.localhost\Ubuntu\home\alice`
    )
  })

  it('falls back to the distro root when home cannot be resolved', () => {
    expect(buildWslPickerDefaultPath('Ubuntu', null)).toBe(String.raw`\\wsl.localhost\Ubuntu`)
  })
})
