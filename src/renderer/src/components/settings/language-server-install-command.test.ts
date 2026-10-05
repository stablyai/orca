import { describe, expect, it } from 'vitest'
import {
  buildLanguageServerInstallCommand,
  installShellFamily
} from './language-server-install-command'

describe('installShellFamily', () => {
  it('detects PowerShell, cmd and POSIX shells', () => {
    expect(installShellFamily('pwsh.exe', true)).toBe('powershell')
    expect(
      installShellFamily('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', true)
    ).toBe('powershell')
    expect(installShellFamily('cmd.exe', true)).toBe('cmd')
    expect(installShellFamily('/bin/zsh', false)).toBe('posix')
    expect(installShellFamily(undefined, true)).toBe('powershell')
    expect(installShellFamily(undefined, false)).toBe('posix')
  })

  it('handles unknown shells and whitespace-only shells', () => {
    expect(installShellFamily('nu.exe', true)).toBe('powershell')
    expect(installShellFamily('   ', true)).toBe('powershell')
  })

  it('detects Git Bash as POSIX', () => {
    expect(installShellFamily('git-bash', true)).toBe('posix')
  })
})

describe('buildLanguageServerInstallCommand', () => {
  it('changes into the project so shims install for the project Ruby', () => {
    expect(buildLanguageServerInstallCommand('gem install ruby-lsp', "/code/it's", 'posix')).toBe(
      "cd -- '/code/it'\\''s' && gem install ruby-lsp"
    )
    expect(
      buildLanguageServerInstallCommand('gem install ruby-lsp', "C:\\it's", 'powershell')
    ).toBe("Set-Location -LiteralPath 'C:\\it''s'; gem install ruby-lsp")
    expect(buildLanguageServerInstallCommand('gem install ruby-lsp', 'C:\\code', 'cmd')).toBe(
      'pushd "C:\\code" && gem install ruby-lsp'
    )
  })

  it('avoids environment variable expansion in cmd paths', () => {
    expect(
      buildLanguageServerInstallCommand('gem install ruby-lsp', 'C:\\Users\\%TEMP%', 'cmd')
    ).toBe('gem install ruby-lsp')
  })

  it('quotes special characters in cmd paths safely', () => {
    expect(
      buildLanguageServerInstallCommand('gem install ruby-lsp', 'C:\\code&data^test', 'cmd')
    ).toBe('pushd "C:\\code&data^test" && gem install ruby-lsp')
  })

  it('protects POSIX paths starting with dash', () => {
    expect(buildLanguageServerInstallCommand('gem install ruby-lsp', '-L/code', 'posix')).toBe(
      "cd -- '-L/code' && gem install ruby-lsp"
    )
  })

  it('returns bare command for WSL shells', () => {
    expect(
      buildLanguageServerInstallCommand('gem install ruby-lsp', 'C:\\code', 'posix', 'wsl.exe')
    ).toBe('gem install ruby-lsp')
    expect(
      buildLanguageServerInstallCommand('gem install ruby-lsp', 'C:\\code', 'posix', 'wsl')
    ).toBe('gem install ruby-lsp')
  })
})
