import { findOptionOccurrence } from './command-option-occurrence'
import type { AgentType } from './agent-status-types'

// Required values consume dash-leading text; boolean and optional-valued options are excluded.
// Codex (clap) and OpenCode (yargs) never take a dash-leading value, so they have no entry.
const AGENT_REQUIRED_VALUE_OPTIONS: Partial<Record<AgentType, readonly string[]>> = {
  claude: [
    '--add-dir',
    '--agent',
    '--agents',
    '--allowedTools',
    '--allowed-tools',
    '--append-system-prompt',
    '--append-system-prompt-file',
    '--autocompact',
    '--betas',
    '--debug-file',
    '--disallowedTools',
    '--disallowed-tools',
    '--effort',
    '--environment',
    '--fallback-model',
    '--file',
    '--input-format',
    '--json-schema',
    '--max-budget-usd',
    '--mcp-config',
    '--model',
    '-n',
    '--name',
    '--output-format',
    '--permission-mode',
    '--permission-prompts',
    '--permission-prompt-tool',
    '--plugin-dir',
    '--plugin-url',
    '--remote-control-session-name-prefix',
    '--session-id',
    '--setting-sources',
    '--settings',
    '--system-prompt',
    '--system-prompt-file',
    '--system-prompt-snapshot',
    '--tools'
  ],
  cursor: [
    '--api-key',
    '-H',
    '--header',
    '-e',
    '--endpoint',
    '--output-format',
    '--mode',
    '--model',
    '--sandbox',
    '--workspace',
    '--add-dir',
    '--plugin-dir',
    '--worktree-base'
  ]
}

export function agentArgTerminatorIndex(agent: AgentType, tokens: readonly string[]): number {
  return (
    findOptionOccurrence(tokens, ['--'], false, agentRequiredValueOptions(agent))?.index ??
    tokens.length
  )
}

export function agentArgOptionTokens(tokens: readonly string[]): readonly string[] {
  const terminator = tokens.indexOf('--')
  return terminator === -1 ? tokens : tokens.slice(0, terminator)
}

/** Removes each occurrence before `--`, or only those whose value `matchesValue` accepts. */
export function removeAgentArgOption(
  agent: AgentType,
  tokens: readonly string[],
  aliases: readonly string[],
  matchesValue: (value: string | undefined) => boolean = () => true
): string[] {
  const kept: string[] = []
  const required = agentRequiredValueOptions(agent)
  let cursor = 0
  let found = findOptionOccurrence(tokens, aliases, true, required, cursor)
  while (found) {
    const end = found.index + found.consumed
    const keptEnd = matchesValue(found.value) ? found.index : end
    for (let index = cursor; index < keptEnd; index += 1) {
      kept.push(tokens[index])
    }
    cursor = end
    found = findOptionOccurrence(tokens, aliases, true, required, cursor)
  }
  for (let index = cursor; index < tokens.length; index += 1) {
    kept.push(tokens[index])
  }
  return kept
}

/** Shared required-operand facts for terminal parsing, including CLI-sharing teams. */
export function agentRequiredValueOptions(agent: string): readonly string[] {
  const value: unknown = Object.getOwnPropertyDescriptor(
    AGENT_REQUIRED_VALUE_OPTIONS,
    agent === 'claude-agent-teams' ? 'claude' : agent
  )?.value
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string')
    ? value
    : []
}
