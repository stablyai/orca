import {
  analyzeAgentChoiceWords,
  CLAUDE_VARIADIC,
  permissionOptionInventory
} from './agent-permission-args'
import { YOLO_TUI_AGENT_ARGS } from './tui-agent-permissions'
import { findAgentExecutableIndex, isAgentExecutableToken } from '../startup/agent-executable-args'
import { tokenizeStartupCommand, type AgentStartupShell } from '../startup/tui-agent-startup-shell'
import { TUI_AGENT_CONFIG } from '../catalog/tui-agent-config'
import type { TuiAgent } from '../catalog/tui-agent'

const CLAUDE_BYPASS_FLAG = YOLO_TUI_AGENT_ARGS.claude
// Claude lets bypass run as root inside a declared sandbox; Orca never sets these itself.
const CLAUDE_ROOT_SANDBOX_ENV = ['IS_SANDBOX', 'CLAUDE_CODE_BUBBLEWRAP'] as const

function declaresSandboxPrefix(token: string): boolean {
  return CLAUDE_ROOT_SANDBOX_ENV.some(
    (name) => token.startsWith(`${name}=`) && token.length > name.length + 1
  )
}

export const CLAUDE_ROOT_BYPASS_NOTICE =
  `\r\n[orca] Claude won't use Full access while it runs as root, so Orca started it without ${CLAUDE_BYPASS_FLAG}, under Claude's own permission default. ` +
  "To stop this notice, choose another permission for Claude in this host's Settings > Agents.\r\n"

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

/** Bypass requests besides Orca's switch; Claude refuses any of them as root, so removal alone can't help. */
function asksBypassOtherwise(tokens: readonly string[]): boolean {
  return tokens.some(
    (token, index) =>
      token === '--allow-dangerously-skip-permissions' ||
      token === '--permission-mode=bypassPermissions' ||
      (token === '--permission-mode' && tokens[index + 1] === 'bypassPermissions') ||
      // Inline settings JSON can set defaultMode; a settings file is not read here.
      (token.startsWith('--settings=') && token.includes('bypassPermissions')) ||
      (token === '--settings' && tokens[index + 1]?.includes('bypassPermissions') === true)
  )
}

/** True when the token before the switch would take the word after it as a value once the switch is gone. */
function previousTakesNextWord(
  previous: string,
  previousRole: string | undefined,
  switches: ReadonlySet<string>
): boolean {
  if (previousRole?.startsWith('option:')) {
    const name = previousRole.slice('option:'.length)
    const inlineValue = previous !== name
    return inlineValue ? CLAUDE_VARIADIC.includes(name) : !switches.has(name)
  }
  if (previousRole?.startsWith('value:')) {
    return CLAUDE_VARIADIC.includes(previousRole.slice('value:'.length))
  }
  return true
}

/** `command` without Claude's bypass switch, or null when it can't be removed safely and to effect. */
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
  if (
    start < 1 ||
    parsed.tokens.slice(0, start).some(declaresSandboxPrefix) ||
    asksBypassOtherwise(parsed.tokens)
  ) {
    return null
  }
  // Claude's option grammar: a prompt, an option value or text after `--` never counts as the switch.
  const words = parsed.tokens.slice(start)
  const { roles } = analyzeAgentChoiceWords('claude', words)
  const { switches } = permissionOptionInventory('claude')
  let next = command
  const removed = new Set<number>()
  for (let index = parsed.tokens.length - 1; index >= start; index -= 1) {
    if (
      parsed.tokens[index] !== CLAUDE_BYPASS_FLAG ||
      roles[index - start] !== `option:${CLAUDE_BYPASS_FLAG}`
    ) {
      continue
    }
    // Look ahead in the rewritten words, so a repeated switch can't hide the word it would expose.
    let following = index + 1
    while (removed.has(following)) {
      following += 1
    }
    const span = parsed.spans[index]
    const gapStart = parsed.spans[index - 1].end
    if (
      span.divergesFromShell ||
      !/^[ \t]+$/.test(command.slice(gapStart, span.start)) ||
      (index > start &&
        !(parsed.tokens[following] ?? '-').startsWith('-') &&
        previousTakesNextWord(parsed.tokens[index - 1], roles[index - start - 1], switches))
    ) {
      return null
    }
    next = next.slice(0, gapStart) + next.slice(span.end)
    removed.add(index)
  }
  return removed.size > 0 ? next : null
}

/** The root-host launch plan: a command without the switch and its notice, or null to spawn as asked. */
export function planClaudeRootLaunch(args: {
  command: string | undefined
  agent: TuiAgent | undefined
  shell: AgentStartupShell
  isRoot: boolean
  env: readonly (Readonly<Record<string, string | undefined>> | undefined)[]
}): { command: string; notice: string } | null {
  if (
    !args.command ||
    !args.isRoot ||
    args.env.some((env) => CLAUDE_ROOT_SANDBOX_ENV.some((name) => env?.[name]))
  ) {
    return null
  }
  const command = withoutClaudeRootBypass(args.command, args.agent, args.shell)
  return command === null ? null : { command, notice: CLAUDE_ROOT_BYPASS_NOTICE }
}
