import { describe, expect, it } from 'vitest'
import { resolveWindowsShellLaunchTarget } from './windows-shell-launch'

describe('resolveWindowsShellLaunchTarget', () => {
  it('keeps the explicit Windows PowerShell profile when pwsh is available', () => {
    expect(resolveWindowsShellLaunchTarget('powershell.exe')).toBe('powershell.exe')
  })

  it('keeps the explicit Windows PowerShell profile when pwsh is unavailable', () => {
    expect(resolveWindowsShellLaunchTarget('powershell.exe')).toBe('powershell.exe')
  })

  it('keeps PowerShell 7 as a separate explicit profile', () => {
    expect(resolveWindowsShellLaunchTarget('pwsh.exe')).toBe('pwsh.exe')
  })

  it('passes through non-PowerShell shells unchanged', () => {
    expect(resolveWindowsShellLaunchTarget('cmd.exe')).toBe('cmd.exe')
    expect(resolveWindowsShellLaunchTarget('wsl.exe')).toBe('wsl.exe')
    expect(resolveWindowsShellLaunchTarget('git-bash')).toBe('git-bash')
  })
})
