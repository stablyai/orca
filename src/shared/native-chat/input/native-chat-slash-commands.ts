// Share pure slash-command data across desktop/mobile without DOM/RN dependencies or mirrored catalogs.

import type { AgentSessionSlashCommand } from '../../agent-session-wire'
import type { AgentType } from '../../agent-status-types'

/** Terminal replies: composer answers locally without sending; transcript surfaces an agent-written row; absent means terminal/effect-only feedback. */
export type NativeChatCommandReply = 'composer' | 'transcript'

export type SlashCommandSuggestion = {
  /** The command token without its leading slash, e.g. `clear`. */
  name: string
  /** Optional one-line description for the suggestion row. */
  description?: string
  /** Provider-authored argument sketch, e.g. `<objective>`. */
  argumentHint?: string
  kindUnspecified?: true
  /** Declared only on curated rows; a surface that cannot show the reply drops the row. */
  reply?: NativeChatCommandReply
  /** The desktop chat runs it itself: it hides an agent command of the same name, never a skill. */
  orcaOwned?: true
}

// Curated stable commands: CLIs provide no machine-readable catalog.

const COMMON_COMMANDS: readonly SlashCommandSuggestion[] = [
  { name: 'clear', description: 'Clear the conversation' },
  { name: 'help', description: 'Show available commands' }
]

const CLAUDE_COMMANDS: readonly SlashCommandSuggestion[] = [
  { name: 'clear', description: 'Clear conversation history' },
  { name: 'compact', description: 'Summarize and compact the conversation' },
  { name: 'init', description: 'Initialize a CLAUDE.md' },
  { name: 'review', description: 'Review the current changes' },
  { name: 'help', description: 'Show available commands' }
]

// Why: OpenClaude writes its `/context` report to the transcript; Claude's TUI does not.
const OPENCLAUDE_COMMANDS: readonly SlashCommandSuggestion[] = [
  ...CLAUDE_COMMANDS,
  { name: 'context', description: 'Show context usage', reply: 'transcript' }
]

const CODEX_COMMANDS: readonly SlashCommandSuggestion[] = [
  { name: 'model', description: 'Choose the model and reasoning effort' },
  { name: 'ide', description: 'Include IDE context' },
  { name: 'permissions', description: 'Choose what Codex is allowed to do' },
  { name: 'keymap', description: 'Remap TUI shortcuts' },
  { name: 'vim', description: 'Toggle Vim mode' },
  { name: 'experimental', description: 'Toggle experimental features' },
  { name: 'approve', description: 'Approve one auto-review retry' },
  { name: 'memories', description: 'Configure memory use' },
  { name: 'skills', description: 'Manage and use skills' },
  { name: 'import', description: 'Import setup from Claude Code' },
  { name: 'hooks', description: 'View lifecycle hooks' },
  { name: 'review', description: 'Review the current changes' },
  { name: 'rename', description: 'Rename the current thread' },
  { name: 'new', description: 'Start a new chat' },
  { name: 'archive', description: 'Archive this session and exit' },
  { name: 'delete', description: 'Delete this session and exit' },
  { name: 'resume', description: 'Resume a saved chat' },
  { name: 'fork', description: 'Fork the current chat' },
  { name: 'app', description: 'Continue in Codex Desktop' },
  { name: 'init', description: 'Create an AGENTS.md file' },
  { name: 'compact', description: 'Compact the conversation' },
  { name: 'plan', description: 'Switch to Plan mode' },
  { name: 'goal', description: 'Set or view the goal' },
  { name: 'agent', description: 'Switch the active agent thread' },
  { name: 'side', description: 'Start a side conversation' },
  { name: 'copy', description: 'Copy the last response as markdown' },
  { name: 'raw', description: 'Toggle raw scrollback mode' },
  { name: 'diff', description: 'Show the working diff' },
  { name: 'mention', description: 'Mention a file' },
  { name: 'status', description: 'Show session configuration and usage' },
  { name: 'usage', description: 'View account usage' },
  { name: 'title', description: 'Configure the terminal title' },
  { name: 'statusline', description: 'Configure the status line' },
  { name: 'theme', description: 'Choose a syntax highlighting theme' },
  { name: 'pets', description: 'Choose or hide the terminal pet' },
  { name: 'mcp', description: 'List configured MCP tools' },
  { name: 'plugins', description: 'Browse plugins' },
  { name: 'logout', description: 'Log out of Codex' },
  { name: 'exit', description: 'Exit Codex' },
  { name: 'feedback', description: 'Send logs to maintainers' },
  { name: 'ps', description: 'List background terminals' },
  { name: 'stop', description: 'Stop all background terminals' },
  { name: 'clear', description: 'Clear the terminal and start a new chat' },
  { name: 'personality', description: 'Choose a communication style' },
  { name: 'subagents', description: 'Switch the active agent thread' }
]

// OMP built-in registry; interactive commands still execute in its terminal.
const OMP_COMMANDS: readonly SlashCommandSuggestion[] = [
  { name: 'model', description: 'Open the model selector in Terminal' },
  {
    name: 'switch',
    description: 'Open the temporary model selector in Terminal'
  },
  { name: 'plan', description: 'Toggle plan mode' },
  { name: 'compact', description: 'Compact conversation context' },
  { name: 'clear', description: 'Clear context while keeping the session' },
  { name: 'new', description: 'Start a new session' },
  { name: 'resume', description: 'Resume a session; without arguments, choose in Terminal' },
  { name: 'fork', description: 'Fork from a previous message in Terminal' },
  { name: 'branch', description: 'Rewind to a previous message in Terminal' },
  { name: 'tree', description: 'Browse the session tree in Terminal' },
  { name: 'session', description: 'Show session information and controls' },
  { name: 'rename', description: 'Rename the session' },
  // Why: OMP paints this in its TUI and records nothing the chat could show.
  { name: 'context', description: 'Show estimated context usage', reply: 'composer' },
  { name: 'usage', description: 'Show provider usage and limits' },
  { name: 'fast', description: 'Toggle priority service tier' },
  { name: 'tools', description: 'Show tools visible to the agent' },
  { name: 'jobs', description: 'Show background jobs' },
  { name: 'git', description: 'Open the Git viewer in Terminal' },
  { name: 'export', description: 'Export the session to HTML' },
  { name: 'settings', description: 'Open settings in Terminal' },
  { name: 'extensions', description: 'Open the extension dashboard in Terminal' },
  { name: 'hotkeys', description: 'Show keyboard shortcuts in Terminal' }
]

const COMMANDS_BY_AGENT: Partial<Record<AgentType, readonly SlashCommandSuggestion[]>> = {
  claude: CLAUDE_COMMANDS,
  openclaude: OPENCLAUDE_COMMANDS,
  codex: CODEX_COMMANDS,
  omp: OMP_COMMANDS
}

/** Known slash commands for an agent, falling back to a small common set so the
 *  `/` menu is never empty for a recognized agent. */
export function getAgentSlashCommands(agent: AgentType): readonly SlashCommandSuggestion[] {
  return COMMANDS_BY_AGENT[agent] ?? COMMON_COMMANDS
}

/** Session reports own command presence/descriptions; curated rows fill missing prose. Exclude skills into their own picker group. */
export function sessionSlashCommandSuggestions(
  agent: AgentType,
  reported: readonly AgentSessionSlashCommand[]
): readonly SlashCommandSuggestion[] {
  const described = new Map(
    getAgentSlashCommands(agent).map((command) => [command.name, command.description])
  )
  return reported
    .filter((entry) => entry.kind === 'command')
    .map((entry) => {
      const description = entry.description ?? described.get(entry.name)
      return {
        name: entry.name,
        ...(description ? { description } : {}),
        ...(entry.argumentHint ? { argumentHint: entry.argumentHint } : {}),
        ...(entry.kindUnspecified ? { kindUnspecified: true as const } : {})
      }
    })
}

export type NativeChatSessionSkill = Pick<AgentSessionSlashCommand, 'name' | 'description' | 'path'>

export function sessionReportedSkills(
  reported: readonly AgentSessionSlashCommand[]
): readonly NativeChatSessionSkill[] {
  return reported.flatMap((entry) =>
    entry.kind === 'skill'
      ? [
          {
            name: entry.name,
            ...(entry.description ? { description: entry.description } : {}),
            ...(entry.path ? { path: entry.path } : {})
          }
        ]
      : []
  )
}

/** Slash drafts are TUI controls; suppress optimistic user bubbles for them. */
export function isSlashCommandDraft(draft: string): boolean {
  return draft.trimStart().startsWith('/')
}

/** Case-insensitive prefix matching; empty query opens the full command list. */
export function filterSlashCommands(
  commands: readonly SlashCommandSuggestion[],
  query: string
): SlashCommandSuggestion[] {
  const normalized = query.toLowerCase()
  if (normalized === '') {
    return [...commands]
  }
  return commands.filter((command) => command.name.toLowerCase().startsWith(normalized))
}

/** Tab completion keeps a trailing argument space. */
export function applySlashSuggestion(command: SlashCommandSuggestion): string {
  return `/${command.name} `
}

/** Enter dispatch omits the trailing completion space. */
export function slashCommandDispatchText(command: SlashCommandSuggestion): string {
  return `/${command.name}`
}

export type NativeChatSendClassification = 'chat' | 'command' | 'unknown-token'

export function classifyNativeChatSend(
  draft: string,
  commands: readonly SlashCommandSuggestion[],
  pickerSkillOriginToken: string | null,
  skillPrefix: '/' | '$' | null
): NativeChatSendClassification {
  // TUIs dispatch only line-leading tokens; trimming whitespace would claim commands the agent received as prose.
  const firstToken = draft.split(/\s/, 1)[0] ?? ''
  if (pickerSkillOriginToken && firstToken === pickerSkillOriginToken) {
    return 'chat'
  }
  if (commands.some((command) => firstToken === `/${command.name}`)) {
    return 'command'
  }
  if (firstToken.startsWith('/')) {
    return 'unknown-token'
  }
  // $ is Codex grammar only; other agents’ $PATH-like tokens remain prose with bubbles/attachments.
  if (skillPrefix === '$' && firstToken.startsWith('$')) {
    return 'unknown-token'
  }
  return 'chat'
}
