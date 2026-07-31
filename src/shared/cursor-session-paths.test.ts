import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveCursorGlobalStateDbPath } from './cursor-session-paths'

describe('resolveCursorGlobalStateDbPath', () => {
  it('resolves the macOS Cursor globalStorage path', () => {
    const previous = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    expect(resolveCursorGlobalStateDbPath({}, '/Users/dev')).toBe(
      '/Users/dev/Library/Application Support/Cursor/User/globalStorage/state.vscdb'
    )
    Object.defineProperty(process, 'platform', { value: previous })
  })

  it('resolves the Windows APPDATA path', () => {
    const previous = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    expect(
      resolveCursorGlobalStateDbPath(
        { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' },
        'C:\\Users\\dev'
      )
    ).toBe(
      join('C:\\Users\\dev\\AppData\\Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
    )
    Object.defineProperty(process, 'platform', { value: previous })
  })

  it('resolves Linux XDG_CONFIG_HOME when set', () => {
    const previous = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux' })
    expect(resolveCursorGlobalStateDbPath({ XDG_CONFIG_HOME: '/custom/config' }, '/home/dev')).toBe(
      '/custom/config/Cursor/User/globalStorage/state.vscdb'
    )
    Object.defineProperty(process, 'platform', { value: previous })
  })
})
