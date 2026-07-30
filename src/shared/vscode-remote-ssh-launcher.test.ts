import { describe, expect, it } from 'vitest'
import { isVsCodeLauncherExecutable, isVsCodeRemoteSshCommand } from './vscode-remote-ssh-launcher'

describe('VS Code Remote-SSH launcher capability', () => {
  it.each([
    'code',
    'code-insiders',
    '/usr/local/bin/code',
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    'C:\\Program Files\\Microsoft VS Code Insiders\\Code - Insiders.exe',
    'C:\\Tools\\CODE.CMD',
    'C:\\Tools\\code-insiders.bat'
  ])('recognizes a safe configured launcher: %s', (command) => {
    expect(isVsCodeRemoteSshCommand(command)).toBe(true)
  })

  it.each(['cursor', 'zed', 'code --reuse-window', 'open -a "Visual Studio Code"'])(
    'rejects an unsupported or compound command: %s',
    (command) => {
      expect(isVsCodeRemoteSshCommand(command)).toBe(false)
    }
  )

  it('recognizes resolved Windows launchers by executable basename', () => {
    expect(isVsCodeLauncherExecutable('C:\\Tools\\Code - Insiders.exe')).toBe(true)
    expect(isVsCodeLauncherExecutable('C:\\Tools\\cursor.exe')).toBe(false)
  })
})
