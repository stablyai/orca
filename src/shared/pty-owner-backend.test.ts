import { describe, expect, it } from 'vitest'
import { resolvePtyOwnerBackend } from './pty-owner-backend'

describe('resolvePtyOwnerBackend', () => {
  it.each([
    ['win32', 'powershell.exe', null, 'windows-conpty'],
    ['win32', 'C:\\Program Files\\Git\\bin\\bash.exe', null, 'windows-conpty'],
    ['win32', undefined, null, 'windows-conpty'],
    ['win32', 'wsl.exe', null, 'windows-wsl'],
    ['win32', 'C:\\Windows\\System32\\wsl.exe', 'Ubuntu', 'windows-wsl'],
    ['win32', 'powershell.exe', 'Ubuntu', 'windows-conpty'],
    ['win32', undefined, 'Ubuntu', 'windows-wsl'],
    ['darwin', '/bin/zsh', null, 'posix-pty'],
    ['linux', '/bin/bash', null, 'posix-pty']
  ] as const)('%s %s with %s resolves to %s', (platform, shellPath, wslDistro, expected) => {
    expect(resolvePtyOwnerBackend({ platform, shellPath, wslDistro })).toBe(expected)
  })
})
