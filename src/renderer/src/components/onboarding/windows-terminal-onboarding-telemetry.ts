import { WINDOWS_GIT_BASH_SHELL } from '../../../../shared/windows-terminal-shell'
import type { EventProps } from '../../../../shared/telemetry-events'
import type { GlobalSettings } from '../../../../shared/types'

type WindowsTerminalSnapshot = EventProps<'onboarding_windows_terminal_snapshot'>

type WindowsTerminalSnapshotArgs = {
  settings: GlobalSettings | null | undefined
  exitAction: WindowsTerminalSnapshot['exit_action']
  durationMs: number
  advancedVia: NonNullable<WindowsTerminalSnapshot['advanced_via']>
}

export function bucketWindowsTerminalShell(
  shell: string | null | undefined
): WindowsTerminalSnapshot['default_shell'] {
  // Why: shell values may become explicit paths; telemetry keeps only a
  // bounded product bucket and never sends the path or WSL distro name.
  const normalized = (shell ?? '').toLowerCase()
  const normalizedName = normalized.replaceAll('\\', '/').split('/').pop()
  if (normalized === 'powershell.exe' || normalized === 'pwsh.exe') {
    return 'powershell'
  }
  if (normalized === 'cmd.exe') {
    return 'command_prompt'
  }
  if (normalized === WINDOWS_GIT_BASH_SHELL || normalizedName === 'bash.exe') {
    return 'git_bash'
  }
  if (normalized === 'wsl.exe' || normalized.startsWith('wsl')) {
    return 'wsl'
  }
  return 'other'
}

export function buildWindowsTerminalSnapshotPayload({
  settings,
  exitAction,
  durationMs,
  advancedVia
}: WindowsTerminalSnapshotArgs): WindowsTerminalSnapshot {
  return {
    default_shell: bucketWindowsTerminalShell(settings?.terminalWindowsShell),
    right_click_behavior: settings?.terminalRightClickToPaste ? 'paste' : 'menu',
    exit_action: exitAction,
    duration_ms: durationMs,
    advanced_via: advancedVia
  }
}
