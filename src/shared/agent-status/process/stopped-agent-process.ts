import type { ProcessTableRow } from '../../process-observation/tables/process-table-snapshot'
import { agentOf } from '../../agent-hook-listener/presence/hook-process-root-evidence'
import { MAX_STOPPED_AGENT_KINDS } from '../../terminal/pty/lifecycle/terminal-foreground-observation'
import { tokenizeCommandLine } from './agent-command-line-entrypoint'
import { isTuiAgent } from '../../agent-launch/catalog/tui-agent-config'

/** Agents job control stopped on this terminal, outside the foreground group: suspended agents awaiting `fg`. */
export function findStoppedAgents(
  rows: readonly ProcessTableRow[],
  foregroundGroup: number | undefined
): string[] {
  const agents = new Set<string>()
  for (const row of rows) {
    if (row.pgid !== foregroundGroup && /T/.test(row.stat) && !/Z/.test(row.stat)) {
      // Why no one-shots: `claude -p` cannot take mail, so a stopped one awaits no `fg` on mail's behalf.
      const agent = agentOf(row.command, false)
      if (agent && isTuiAgent(agent) && !(agent === 'codex' && isCodexExec(row.command))) {
        agents.add(agent)
      }
    }
  }
  return [...agents].slice(0, MAX_STOPPED_AGENT_KINDS)
}

// Why local: `codex exec` is one-shot, but the shared headless table also drives Codex's TUI status recognition.
function isCodexExec(command: string): boolean {
  const tokens = tokenizeCommandLine(command)
  const binary = tokens.findIndex((token) => /(?:^|[/\\])codex(?:\.js|\.exe)?$/i.test(token))
  const subcommand = tokens.slice(binary + 1).find((token) => !token.startsWith('-'))
  return binary !== -1 && (subcommand === 'exec' || subcommand === 'e')
}
