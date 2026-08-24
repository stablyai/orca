import { describe, expect, it } from 'vitest'
import { isCursorLauncherExecutable, isCursorRemoteSshCommand } from './cursor-remote-ssh-launcher'

describe('Cursor Remote-SSH launcher capability', () => {
  it.each([
    'cursor',
    'cursor.cmd',
    '/usr/local/bin/cursor',
    '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
    'C:\\Program Files\\Cursor\\Cursor.exe',
    'C:\\Tools\\CURSOR.CMD'
  ])('recognizes a safe configured launcher: %s', (command) => {
    expect(isCursorLauncherExecutable(command)).toBe(true)
    expect(isCursorRemoteSshCommand(command)).toBe(true)
  })

  it.each([
    'code',
    'cursor.bat',
    'tools/cursor',
    '.\\cursor.exe',
    'cursor --new-window',
    'cmd /c cursor',
    'C:\\Tools\\cursor helper.cmd'
  ])('rejects an unsupported or compound launcher: %s', (command) => {
    expect(isCursorRemoteSshCommand(command)).toBe(false)
  })
})
