import { describe, expect, it } from 'vitest'
import { isCmdExeConptyShell } from './terminal-local-windows-cmd-conpty'
import { resolveTerminalShortcutAction } from './terminal-shortcut-policy'
import { TERMINAL_CTRL_BACKSPACE_INPUT } from '../../../../../../shared/terminal/protocol/input-modes/terminal-modified-enter-encoding'

const ctrlBackspace = {
  key: 'Backspace',
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false
}

function resolveCtrlBackspace(isLocalWindowsCmdConptyPane?: () => boolean) {
  return resolveTerminalShortcutAction(
    ctrlBackspace,
    false,
    'false',
    0,
    true,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    isLocalWindowsCmdConptyPane
  )
}

describe('Command Prompt shell detection', () => {
  it('treats cmd.exe paths as Command Prompt and leaves other shells alone', () => {
    expect(isCmdExeConptyShell(true, 'cmd.exe')).toBe(true)
    expect(isCmdExeConptyShell(true, 'C:\\Windows\\System32\\cmd.exe')).toBe(true)
    expect(isCmdExeConptyShell(true, 'powershell.exe')).toBe(false)
    expect(isCmdExeConptyShell(true, 'pwsh.exe')).toBe(false)
    expect(isCmdExeConptyShell(false, 'cmd.exe')).toBe(false)
    expect(isCmdExeConptyShell(true, undefined)).toBe(false)
  })
})

describe('Ctrl+Backspace on a local Windows Command Prompt', () => {
  it('sends BS so ConPTY cooked cmd deletes the previous word', () => {
    expect(resolveCtrlBackspace(() => true)).toEqual({ type: 'sendInput', data: '\b' })
  })

  it('keeps Ctrl+W for PowerShell and other shells', () => {
    expect(resolveCtrlBackspace(() => false)).toEqual({
      type: 'sendInput',
      data: TERMINAL_CTRL_BACKSPACE_INPUT
    })
    expect(resolveCtrlBackspace()).toEqual({
      type: 'sendInput',
      data: TERMINAL_CTRL_BACKSPACE_INPUT
    })
  })
})
