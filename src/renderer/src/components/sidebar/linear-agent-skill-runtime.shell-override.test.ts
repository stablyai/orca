import { describe, expect, it } from 'vitest'
import { getLinearPromptTerminalShellOverride } from './linear-agent-skill-runtime'

const hostRuntime = { runtime: 'host', label: 'Windows' } as const

describe('getLinearPromptTerminalShellOverride', () => {
  // Why: this prompt pastes the same generated Windows command as the settings
  // panes, and Git Bash rewrites its leading /d /s /c arguments as MSYS paths.
  it('forces PowerShell for POSIX-family Windows shells', () => {
    for (const terminalWindowsShell of ['git-bash', 'wsl.exe']) {
      expect(
        getLinearPromptTerminalShellOverride('win32', { terminalWindowsShell }, hostRuntime)
      ).toBe('powershell.exe')
    }
  })

  it('leaves cmd and PowerShell shells alone, and never overrides off Windows', () => {
    expect(
      getLinearPromptTerminalShellOverride(
        'win32',
        { terminalWindowsShell: 'cmd.exe' },
        hostRuntime
      )
    ).toBeUndefined()
    expect(
      getLinearPromptTerminalShellOverride(
        'darwin',
        { terminalWindowsShell: 'git-bash' },
        hostRuntime
      )
    ).toBeUndefined()
  })
})
