import { describe, expect, it } from 'vitest'
import { buildZcodeSetupTerminalCommand } from './zcode-setup-terminal-command'

const invocation = {
  command: 'C:\\Program Files\\ZCode\\ZCode.exe',
  args: ['C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs', 'login', 'zai'],
  env: { ELECTRON_RUN_AS_NODE: '1' }
}

describe('buildZcodeSetupTerminalCommand', () => {
  it('quotes the desktop invocation for PowerShell', () => {
    expect(buildZcodeSetupTerminalCommand(invocation, 'powershell.exe')).toBe(
      "$env:ELECTRON_RUN_AS_NODE = '1'; & 'C:\\Program Files\\ZCode\\ZCode.exe' 'C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs' 'login' 'zai'"
    )
  })

  it('quotes the desktop invocation for cmd', () => {
    expect(buildZcodeSetupTerminalCommand(invocation, 'cmd.exe')).toBe(
      'set "ELECTRON_RUN_AS_NODE=1" & "C:\\Program Files\\ZCode\\ZCode.exe" "C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs" "login" "zai"'
    )
  })

  it('quotes the desktop invocation for POSIX shells', () => {
    expect(buildZcodeSetupTerminalCommand(invocation, 'wsl.exe')).toBe(
      "ELECTRON_RUN_AS_NODE='1' 'C:'\"\\\\\"'Program Files'\"\\\\\"'ZCode'\"\\\\\"'ZCode.exe' 'C:'\"\\\\\"'Program Files'\"\\\\\"'ZCode'\"\\\\\"'resources'\"\\\\\"'glm'\"\\\\\"'zcode.cjs' 'login' 'zai'"
    )
  })
})
