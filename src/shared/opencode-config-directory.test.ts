import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { resolveOpenCodeConfigDirectory } from './opencode-config-directory'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
})

describe('OpenCode consumer config directory', () => {
  it('uses the execution HOME instead of the installer home on POSIX', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    expect(resolveOpenCodeConfigDirectory({ HOME: '/consumer' }, '/installer')).toBe(
      join('/consumer', '.config', 'opencode')
    )
  })

  it('uses the execution USERPROFILE on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    expect(
      resolveOpenCodeConfigDirectory({ USERPROFILE: '/consumer', HOME: '/shell' }, '/installer')
    ).toBe(join('/consumer', '.config', 'opencode'))
  })

  it('keeps the host home fallback when the execution home is absent', () => {
    expect(resolveOpenCodeConfigDirectory({}, '/installer')).toBe(
      join('/installer', '.config', 'opencode')
    )
  })

  it('does not treat a Windows shell HOME as the native OpenCode home', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    expect(resolveOpenCodeConfigDirectory({ HOME: '/shell' }, '/installer')).toBe(
      join('/installer', '.config', 'opencode')
    )
  })

  it('keeps XDG_CONFIG_HOME ahead of the execution home', () => {
    expect(
      resolveOpenCodeConfigDirectory({ HOME: '/consumer', XDG_CONFIG_HOME: '/xdg' }, '/installer')
    ).toBe(join('/xdg', 'opencode'))
  })
})
