import { describe, expect, it } from 'vitest'
import { nativeChatCommandLanguage } from './native-chat-command-language'

describe('nativeChatCommandLanguage', () => {
  it.each([
    ['Bash', { command: 'git status' }, 'shellscript'],
    ['PowerShell', { command: 'Get-ChildItem' }, 'powershell'],
    // A bash tool still ran bash when its command calls another shell.
    ['Bash', { command: 'cmd.exe /c dir' }, 'shellscript']
  ])('trusts a %s tool to name its shell', (name, input, language) => {
    expect(nativeChatCommandLanguage(name, input)).toBe(language)
  })

  it.each([
    [{ command: "/bin/zsh -lc 'git status'" }, 'shellscript'],
    [{ command: ['bash', '-lc', 'ls -la'] }, 'shellscript'],
    [{ command: 'wsl.exe -e bash -lc "ls"' }, 'shellscript'],
    [
      {
        command:
          '"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "Get-ChildItem"'
      },
      'powershell'
    ],
    [{ command: 'pwsh -NoProfile -Command Get-Date' }, 'powershell'],
    [{ cmd: 'C:\\Windows\\System32\\cmd.exe /c dir' }, 'bat']
  ])('reads the shell a generic tool wrapped %j in', (input, language) => {
    expect(nativeChatCommandLanguage('shell', input)).toBe(language)
  })

  it.each([
    { command: 'git status' },
    { command: 'bash' },
    { command: 'python -c "print(1)"' },
    {}
  ])('leaves %j plain when nothing says which shell ran it', (input) => {
    expect(nativeChatCommandLanguage('execute', input)).toBeNull()
  })
})
