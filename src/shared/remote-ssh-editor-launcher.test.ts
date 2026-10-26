import { describe, expect, it } from 'vitest'
import { getRemoteSshEditorKind, isRemoteSshEditorCommand } from './remote-ssh-editor-launcher'

describe('remote SSH editor launcher capability', () => {
  it.each([
    'code',
    'code-insiders',
    'cursor',
    'zed',
    '/usr/local/bin/code',
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    '/usr/bin/zeditor',
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    'C:\\Program Files\\Microsoft VS Code Insiders\\Code - Insiders.exe',
    'C:\\Tools\\CODE.CMD',
    'C:\\Tools\\code-insiders.bat',
    'C:\\Program Files\\cursor\\Cursor.exe'
  ])('recognizes a safe configured launcher: %s', (command) => {
    expect(isRemoteSshEditorCommand(command)).toBe(true)
  })

  it.each(['subl', 'code --reuse-window', 'zed --new', 'open -a "Visual Studio Code"'])(
    'rejects an unsupported or compound command: %s',
    (command) => {
      expect(isRemoteSshEditorCommand(command)).toBe(false)
    }
  )

  it('routes Cursor through Remote-SSH arguments and Zed through its SSH URL', () => {
    expect(getRemoteSshEditorKind('C:\\Tools\\Code - Insiders.exe')).toBe('vscode-remote')
    expect(getRemoteSshEditorKind('C:\\Tools\\cursor.cmd')).toBe('vscode-remote')
    expect(
      getRemoteSshEditorKind('C:\\Users\\ada\\AppData\\Local\\Programs\\Zed\\bin\\zed.exe')
    ).toBe('zed')
    expect(getRemoteSshEditorKind('/usr/bin/subl')).toBeNull()
  })
})
