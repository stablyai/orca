import { afterEach, describe, expect, it, vi } from 'vitest'
import { getTarProgram } from './zip-extractor-command'

describe('tar program resolution', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform!)
    vi.unstubAllEnvs()
  })

  it('win32 resolves the inbox System32 tar, never a PATH lookup', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.stubEnv('SystemRoot', ' ')
    vi.stubEnv('SYSTEMROOT', 'D:\\Win')
    expect(getTarProgram()).toBe('D:\\Win\\System32\\tar.exe')
  })

  it('posix keeps bare tar for PATH resolution', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    expect(getTarProgram()).toBe('tar')
  })
})
