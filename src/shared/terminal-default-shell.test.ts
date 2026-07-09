import { describe, expect, it } from 'vitest'
import {
  assertAbsoluteTerminalShellPath,
  getTerminalDefaultShellOverride,
  isAbsoluteTerminalShellPath,
  normalizeTerminalDefaultShellPath
} from './terminal-default-shell'

describe('terminal default shell settings', () => {
  it('normalizes empty values to null and trims configured paths', () => {
    expect(normalizeTerminalDefaultShellPath(undefined)).toBeNull()
    expect(normalizeTerminalDefaultShellPath('  ')).toBeNull()
    expect(normalizeTerminalDefaultShellPath('  /usr/bin/fish  ')).toBe('/usr/bin/fish')
    expect(normalizeTerminalDefaultShellPath('fish')).toBeNull()
    expect(normalizeTerminalDefaultShellPath('C:\\fish.exe')).toBeNull()
    expect(getTerminalDefaultShellOverride(' /bin/zsh ')).toBe('/bin/zsh')
    expect(getTerminalDefaultShellOverride('fish')).toBeUndefined()
  })

  it('recognizes POSIX absolute shell paths', () => {
    expect(isAbsoluteTerminalShellPath('/bin/bash')).toBe(true)
    expect(isAbsoluteTerminalShellPath('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe(false)
    expect(isAbsoluteTerminalShellPath('\\\\server\\share\\shell.exe')).toBe(false)
    expect(isAbsoluteTerminalShellPath('fish')).toBe(false)
  })

  it('throws for relative shell paths at spawn boundaries', () => {
    expect(() => assertAbsoluteTerminalShellPath('fish')).toThrow(
      'Default terminal shell must be a POSIX absolute path'
    )
    expect(() => getTerminalDefaultShellOverride('fish', { onInvalid: 'throw' })).toThrow(
      'Default terminal shell must be a POSIX absolute path'
    )
  })
})
