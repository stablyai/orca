import { describe, expect, it } from 'vitest'
import {
  isRemoteSshCapableLauncherExecutable,
  isVsCodeLauncherExecutable,
  isVsCodeRemoteSshCommand
} from './vscode-remote-ssh-launcher'

describe('VS Code Remote-SSH launcher capability', () => {
  it.each([
    'code',
    'code-insiders',
    'cursor',
    'cursor-insiders',
    '/usr/local/bin/code',
    '/usr/local/bin/cursor',
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    'C:\\Program Files\\Microsoft VS Code Insiders\\Code - Insiders.exe',
    'C:\\Tools\\CODE.CMD',
    'C:\\Tools\\code-insiders.bat',
    'C:\\Program Files\\cursor\\Cursor.exe'
  ])('recognizes a safe configured launcher: %s', (command) => {
    expect(isVsCodeRemoteSshCommand(command)).toBe(true)
  })

  it.each(['zed', 'subl', 'code --reuse-window', 'open -a "Visual Studio Code"'])(
    'rejects an unsupported or compound command: %s',
    (command) => {
      expect(isVsCodeRemoteSshCommand(command)).toBe(false)
    }
  )

  it('recognizes resolved Windows launchers by executable basename', () => {
    expect(isVsCodeLauncherExecutable('C:\\Tools\\Code - Insiders.exe')).toBe(true)
    expect(isRemoteSshCapableLauncherExecutable('C:\\Tools\\cursor.exe')).toBe(true)
  })

  it('keeps the VS Code-only check narrow so forks skip VS Code-specific behavior', () => {
    expect(isVsCodeLauncherExecutable('cursor')).toBe(false)
    expect(isVsCodeLauncherExecutable('C:\\Tools\\cursor.exe')).toBe(false)
    expect(isRemoteSshCapableLauncherExecutable('zed')).toBe(false)
  })
})
