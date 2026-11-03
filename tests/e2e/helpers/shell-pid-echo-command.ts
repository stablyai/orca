import type { AgentStartupShell } from '../../../src/shared/tui-agent-startup-shell'

/**
 * A command that prints `marker` then the shell's own pid. The typed line never holds the marker
 * followed by digits, so only the command's output matches `marker(\d+)`.
 */
export function shellPidEchoCommand(marker: string, shell: AgentStartupShell): string {
  switch (shell) {
    case 'posix':
      // fish has no `$$`; a child sh reports the pane shell as its parent in every Unix shell.
      return `sh -c 'echo "${marker}$PPID"'`
    case 'powershell':
      // PowerShell's `$$` is the previous line's last token; its own pid is `$PID`.
      return `echo ('${marker}' + $PID)`
    case 'cmd':
      throw new Error('cmd.exe has no variable that holds its own pid')
  }
}
