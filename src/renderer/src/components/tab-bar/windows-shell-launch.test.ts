import { describe, expect, it } from 'vitest'
import { resolveWindowsShellLaunchTarget } from './windows-shell-launch'

describe('resolveWindowsShellLaunchTarget', () => {
  it('uses PowerShell 7+ for Auto when pwsh is available', () => {
    expect(resolveWindowsShellLaunchTarget('powershell.exe', 'auto', true)).toBe('pwsh.exe')
  })

  it('uses Windows PowerShell for Auto when pwsh is unavailable', () => {
    expect(resolveWindowsShellLaunchTarget('powershell.exe', 'auto', false)).toBe('powershell.exe')
  })

  it('uses the configured PowerShell implementation for the PowerShell menu item', () => {
    expect(resolveWindowsShellLaunchTarget('powershell.exe', 'pwsh.exe', false)).toBe('pwsh.exe')
  })

  it('keeps Windows PowerShell when that implementation remains selected', () => {
    expect(resolveWindowsShellLaunchTarget('powershell.exe', 'powershell.exe', true)).toBe(
      'powershell.exe'
    )
  })

  it('passes through non-PowerShell shells unchanged', () => {
    expect(resolveWindowsShellLaunchTarget('cmd.exe', 'auto', true)).toBe('cmd.exe')
    expect(resolveWindowsShellLaunchTarget('wsl.exe', 'auto', true)).toBe('wsl.exe')
  })
})
