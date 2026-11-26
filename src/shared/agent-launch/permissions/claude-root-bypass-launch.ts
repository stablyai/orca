import { analyzeAgentChoiceWords } from './agent-permission-args'
import { YOLO_TUI_AGENT_ARGS } from './tui-agent-permissions'
import { findAgentExecutableIndex, isAgentExecutableToken } from '../startup/agent-executable-args'
import { tokenizeStartupCommand, type AgentStartupShell } from '../startup/tui-agent-startup-shell'
import { TUI_AGENT_CONFIG } from '../catalog/tui-agent-config'
import type { TuiAgent } from '../catalog/tui-agent'

const CLAUDE_BYPASS_FLAG = YOLO_TUI_AGENT_ARGS.claude

export const CLAUDE_ROOT_BYPASS_NOTICE =
  `\r\n[orca] Claude won't use Full access while it runs as root, so Orca started it without ${CLAUDE_BYPASS_FLAG}. ` +
  "It will ask before it acts. To stop this notice, choose another permission for Claude in this host's Settings > Agents.\r\n"

/** First argv index Claude itself parses, after `claude` or Agent Teams' `orca claude-teams`; -1 when absent. */
function claudeArgsStart(
  agent: TuiAgent,
  tokens: readonly string[],
  shell: AgentStartupShell
): number {
  if (agent === 'claude') {
    const index = findAgentExecutableIndex(tokens, shell, (token) =>
      isAgentExecutableToken(token, ['claude'])
    )
    return index < 0 ? -1 : index + 1
  }
  const config = TUI_AGENT_CONFIG['claude-agent-teams']
  const names = [config.detectCmd, ...(config.detectCmdAliases ?? [])]
  const index = findAgentExecutableIndex(tokens, shell, (token) =>
    isAgentExecutableToken(token, names)
  )
  return index >= 0 && tokens[index + 1] === 'claude-teams' ? index + 2 : -1
}

/**
 * `command` without Claude's bypass switch, or null when it has none Orca can remove safely. Claude
 * refuses that switch as root and exits; removing it starts Claude with its own permission default.
 */
export function withoutClaudeRootBypass(
  command: string,
  agent: TuiAgent | undefined,
  shell: AgentStartupShell
): string | null {
  if (agent !== 'claude' && agent !== 'claude-agent-teams') {
    return null
  }
  const parsed = tokenizeStartupCommand(command, shell)
  if (!parsed.ok) {
    return null
  }
  const start = claudeArgsStart(agent, parsed.tokens, shell)
  if (start < 1) {
    return null
  }
  // Claude's option grammar: a prompt, an option value or text after `--` never counts as the switch.
  const { roles } = analyzeAgentChoiceWords('claude', parsed.tokens.slice(start))
  let next = command
  let removed = false
  for (let index = parsed.tokens.length - 1; index >= start; index -= 1) {
    const span = parsed.spans[index]
    const gapStart = parsed.spans[index - 1].end
    if (
      parsed.tokens[index] !== CLAUDE_BYPASS_FLAG ||
      roles[index - start] !== `option:${CLAUDE_BYPASS_FLAG}` ||
      span.divergesFromShell ||
      !/^[ \t]+$/.test(command.slice(gapStart, span.start))
    ) {
      continue
    }
    next = next.slice(0, gapStart) + next.slice(span.end)
    removed = true
  }
  return removed ? next : null
}
