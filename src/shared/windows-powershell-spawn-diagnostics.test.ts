import { describe, expect, it } from 'vitest'
import {
  formatWindowsPowerShellCrashCorrelationHint,
  formatWindowsPowerShellSpawnDiagnostic
} from './windows-powershell-spawn-diagnostics'

describe('windows PowerShell spawn diagnostics', () => {
  it('formats fallback spawn details with startup delivery and safe mode', () => {
    expect(
      formatWindowsPowerShellSpawnDiagnostic({
        sessionId: 'session-1',
        fallbackFromShellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        shellPath: 'C:\\Windows\\System32\\cmd.exe',
        cwd: 'C:\\repo',
        startupDelivery: 'shell-args',
        safeModeNoProfile: false
      })
    ).toBe(
      'windows-powershell-spawn sessionId=session-1 fallbackFrom=C:\\Program Files\\PowerShell\\7\\pwsh.exe shell=C:\\Windows\\System32\\cmd.exe cwd=C:\\repo startupDelivery=shell-args safeModeNoProfile=false'
    )
  })

  it('formats the Windows Event Log crash-correlation hint', () => {
    expect(
      formatWindowsPowerShellCrashCorrelationHint({
        sessionId: 'session-1',
        shellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
      })
    ).toBe(
      'windows-powershell-crash-correlation sessionId=session-1 shell=C:\\Program Files\\PowerShell\\7\\pwsh.exe eventLogProvider=.NET Runtime eventLogProcess=pwsh.exe eventLogException=No process is on the other end of the pipe'
    )
  })
})
