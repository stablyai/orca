import { accessSync, statSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isMacPortsPortExecutablePresent } from './macports-port-executable'

vi.mock('node:fs', () => ({
  accessSync: vi.fn(),
  statSync: vi.fn(),
  constants: { X_OK: 1 }
}))

const PORT_PATH = '/opt/local/bin/port'

describe('isMacPortsPortExecutablePresent', () => {
  afterEach(() => {
    vi.mocked(statSync).mockReset()
    vi.mocked(accessSync).mockReset()
  })

  it('is true for an executable file at the default MacPorts prefix', () => {
    vi.mocked(statSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof statSync>)
    vi.mocked(accessSync).mockReturnValue(undefined)

    expect(isMacPortsPortExecutablePresent()).toBe(true)
    expect(statSync).toHaveBeenCalledWith(PORT_PATH)
  })

  it('is false when port is missing, not a file, or not executable', () => {
    vi.mocked(statSync).mockImplementation(() => {
      throw new Error('ENOENT')
    })
    expect(isMacPortsPortExecutablePresent()).toBe(false)

    vi.mocked(statSync).mockReturnValue({ isFile: () => false } as ReturnType<typeof statSync>)
    expect(isMacPortsPortExecutablePresent()).toBe(false)

    vi.mocked(statSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof statSync>)
    vi.mocked(accessSync).mockImplementation(() => {
      throw new Error('EACCES')
    })
    expect(isMacPortsPortExecutablePresent()).toBe(false)
  })
})
