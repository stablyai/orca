import { describe, expect, it } from 'vitest'
import { WINDOWS_GIT_BASH_SHELL } from '../../../../shared/windows-terminal-shell'
import {
  bucketWindowsTerminalShell,
  buildWindowsTerminalSnapshotPayload
} from './windows-terminal-onboarding-telemetry'

describe('windows terminal onboarding telemetry', () => {
  it('buckets Windows shell settings without exposing raw paths', () => {
    expect(bucketWindowsTerminalShell('powershell.exe')).toBe('powershell')
    expect(bucketWindowsTerminalShell('cmd.exe')).toBe('command_prompt')
    expect(bucketWindowsTerminalShell(WINDOWS_GIT_BASH_SHELL)).toBe('git_bash')
    expect(bucketWindowsTerminalShell('C:\\Program Files\\Git\\bin\\bash.exe')).toBe('git_bash')
    expect(bucketWindowsTerminalShell('wsl.exe')).toBe('wsl')
    expect(bucketWindowsTerminalShell('C:\\custom\\shell.exe')).toBe('other')
  })

  it('builds the low-cardinality step-exit snapshot', () => {
    expect(
      buildWindowsTerminalSnapshotPayload({
        settings: {
          terminalWindowsShell: WINDOWS_GIT_BASH_SHELL,
          terminalRightClickToPaste: false
        } as never,
        exitAction: 'continue',
        durationMs: 1200,
        advancedVia: 'keyboard'
      })
    ).toEqual({
      default_shell: 'git_bash',
      right_click_behavior: 'menu',
      exit_action: 'continue',
      duration_ms: 1200,
      advanced_via: 'keyboard'
    })
  })
})
