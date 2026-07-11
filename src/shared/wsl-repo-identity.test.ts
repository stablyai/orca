import { describe, it, expect } from 'vitest'
import { getRepoDisplayPath, isWslRuntimeResolution } from './wsl-repo-identity'

describe('getRepoDisplayPath', () => {
  it('POSIX for wsl.localhost UNC', () => {
    expect(getRepoDisplayPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\j\\app')).toBe('/home/j/app')
  })
  it('POSIX for legacy wsl$ UNC', () => {
    expect(getRepoDisplayPath('\\\\wsl$\\Ubuntu\\home\\j\\app')).toBe('/home/j/app')
  })
  it('leaves drive + POSIX paths unchanged', () => {
    expect(getRepoDisplayPath('C:\\Users\\j\\app')).toBe('C:\\Users\\j\\app')
    expect(getRepoDisplayPath('/home/j/app')).toBe('/home/j/app')
  })
})
describe('isWslRuntimeResolution', () => {
  it('true only for resolved wsl', () => {
    expect(isWslRuntimeResolution({ status: 'resolved', runtime: { kind: 'wsl' } as never })).toBe(
      true
    )
    expect(
      isWslRuntimeResolution({ status: 'resolved', runtime: { kind: 'windows-host' } as never })
    ).toBe(false)
    expect(isWslRuntimeResolution(undefined)).toBe(false)
    expect(isWslRuntimeResolution({ status: 'repair-required', repair: {} as never })).toBe(false)
  })
})
