// Share pure slash-command data across desktop/mobile without DOM/RN dependencies or mirrored catalogs.

import type { AgentSessionSlashCommand } from '../../../agent-session/agent-session-wire'
import type { AgentType } from '../../../agent-status/contracts/agent-status-types'

/** Terminal replies: composer answers locally without sending; transcript surfaces an agent-written row; absent means terminal/effect-only feedback. */
export type NativeChatCommandReply = 'composer' | 'transcript'

export type SlashCommandSuggestion = {
  /** The command token without its leading slash, e.g. `clear`. */
  name: string
  /** Optional one-line description for the suggestion row. */
  description?: string
  /** Provider-authored argument sketch, e.g. `<objective>`. */
  argumentHint?: string
  /** Other lowercase names the picker finds it by, matched like the name in every language. */
  aliases?: readonly string[]
  kindUnspecified?: true
  builtin?: true
  /** Declared only on curated rows; a surface that cannot show the reply drops the row. */
  reply?: NativeChatCommandReply
  /** The desktop chat runs it itself: it hides an agent command of the same name, never a skill. */
  orcaOwned?: true
  /** Sent bare, it opens a TUI screen the chat cannot show, so a terminal-backed chat switches to Terminal. */
  opensInTerminal?: true
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
  { name: 'permissions', description: 'Choose what Codex is allowed to do', opensInTerminal: true },
  { name: 'keymap', description: 'Remap TUI shortcuts', opensInTerminal: true },
  { name: 'vim', description: 'Toggle Vim mode' },
  { name: 'experimental', description: 'Toggle experimental features', opensInTerminal: true },
  { name: 'approve', description: 'Approve one auto-review retry' },
  { name: 'memories', description: 'Configure memory use', opensInTerminal: true },
  { name: 'skills', description: 'Manage and use skills', opensInTerminal: true },
  { name: 'import', description: 'Import setup from Claude Code' },
  { name: 'hooks', description: 'View lifecycle hooks' },
  { name: 'review', description: 'Review the current changes', opensInTerminal: true },
  { name: 'rename', description: 'Rename the current thread', opensInTerminal: true },
  { name: 'new', description: 'Start a new chat' },
  { name: 'archive', description: 'Archive this session and exit' },
  { name: 'delete', description: 'Delete this session and exit' },
  { name: 'resume', description: 'Resume a saved chat', opensInTerminal: true },
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
  { name: 'title', description: 'Configure the terminal title', opensInTerminal: true },
  { name: 'statusline', description: 'Configure the status line', opensInTerminal: true },
  { name: 'theme', description: 'Choose a syntax highlighting theme', opensInTerminal: true },
  { name: 'pets', description: 'Choose or hide the terminal pet', opensInTerminal: true },
  { name: 'mcp', description: 'List configured MCP tools' },
  { name: 'plugins', description: 'Browse plugins', opensInTerminal: true },
  { name: 'logout', description: 'Log out of Codex' },
  { name: 'exit', description: 'Exit Codex' },
  { name: 'feedback', description: 'Send logs to maintainers', opensInTerminal: true },
  { name: 'ps', description: 'List background terminals' },
  { name: 'stop', description: 'Stop all background terminals' },
  { name: 'clear', description: 'Clear the terminal and start a new chat' },
  { name: 'personality', description: 'Choose a communication style' },
  { name: 'subagents', description: 'Switch the active agent thread', opensInTerminal: true }
]

// OMP built-in registry; interactive commands still execute in its terminal.
const OMP_COMMANDS: readonly SlashCommandSuggestion[] = [
  { name: 'model', description: 'Open the model selector in Terminal', opensInTerminal: true },
  {
    name: 'switch',
    description: 'Open the temporary model selector in Terminal',
    opensInTerminal: true
  },
  { name: 'plan', description: 'Toggle plan mode' },
  { name: 'vibe', description: 'Toggle vibe mode: direct fast/good worker sessions' },
  { name: 'compact', description: 'Compact conversation context' },
  { name: 'clear', description: 'Clear context while keeping the session' },
  { name: 'new', description: 'Start a new session' },
  {
    name: 'resume',
    description: 'Resume a session; without arguments, choose in Terminal',
    opensInTerminal: true
  },
  { name: 'fork', description: 'Fork from a previous message in Terminal', opensInTerminal: true },
  {
    name: 'branch',
    description: 'Rewind to a previous message in Terminal',
    opensInTerminal: true
  },
  { name: 'tree', description: 'Browse the session tree in Terminal', opensInTerminal: true },
  { name: 'session', description: 'Show session information and controls' },
  { name: 'rename', description: 'Rename the session' },
  // Why: OMP paints this in its TUI and records nothing the chat could show.
  { name: 'context', description: 'Show estimated context usage', reply: 'composer' },
  { name: 'usage', description: 'Show provider usage and limits' },
  { name: 'fast', description: 'Toggle priority service tier' },
  { name: 'tools', description: 'Show tools visible to the agent' },
  { name: 'jobs', description: 'Show background jobs' },
  { name: 'git', description: 'Open the Git viewer in Terminal', opensInTerminal: true },
  { name: 'export', description: 'Export the session to HTML' },
  { name: 'settings', description: 'Open settings in Terminal', opensInTerminal: true },
  {
    name: 'extensions',
    description: 'Open the extension dashboard in Terminal',
    opensInTerminal: true
  },
  { name: 'hotkeys', description: 'Show keyboard shortcuts in Terminal', opensInTerminal: true }
]

// Flagged rows open a TUI dialog on OpenCode 1.19.0 or 2.3.0.
const OPENCODE_COMMANDS: readonly SlashCommandSuggestion[] = [
  { name: 'clear', description: 'Clear the conversation' },
  { name: 'models', description: 'Open the model selector in Terminal', opensInTerminal: true },
  { name: 'agents', description: 'Choose the agent in Terminal', opensInTerminal: true },
  { name: 'sessions', description: 'Switch sessions in Terminal', opensInTerminal: true },
  { name: 'skills', description: 'Browse skills in Terminal', opensInTerminal: true },
  { name: 'mcps', description: 'Manage MCP servers in Terminal', opensInTerminal: true },
  { name: 'connect', description: 'Connect a provider in Terminal', opensInTerminal: true },
  { name: 'status', description: 'View status in Terminal', opensInTerminal: true },
  { name: 'themes', description: 'Choose a theme in Terminal', opensInTerminal: true },
  { name: 'diff', description: 'Open the diff viewer in Terminal', opensInTerminal: true },
  { name: 'editor', description: 'Open your editor in Terminal', opensInTerminal: true },
  { name: 'debug', description: 'View debug info in Terminal', opensInTerminal: true },
  { name: 'help', description: 'Show help in Terminal', opensInTerminal: true },
  { name: 'fork', description: 'Fork the session in Terminal', opensInTerminal: true },
  { name: 'rename', description: 'Rename the session in Terminal', opensInTerminal: true },
  {
    name: 'timeline',
    description: 'Browse the session timeline in Terminal',
    opensInTerminal: true
  },
  { name: 'export', description: 'Export the session in Terminal', opensInTerminal: true }
]

const COMMANDS_BY_AGENT: Partial<Record<AgentType, readonly SlashCommandSuggestion[]>> = {
  claude: CLAUDE_COMMANDS,
  openclaude: OPENCLAUDE_COMMANDS,
  codex: CODEX_COMMANDS,
  omp: OMP_COMMANDS,
  opencode: OPENCODE_COMMANDS,
  opencode2: OPENCODE_COMMANDS
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
    .filter((entry) => !isSessionSkill(entry, agent))
    .map((entry) => {
      const description = entry.description ?? described.get(entry.name)
      return {
        name: entry.name,
        ...(description ? { description } : {}),
        ...(entry.argumentHint ? { argumentHint: entry.argumentHint } : {}),
        ...(entry.kindUnspecified ? { kindUnspecified: true as const } : {}),
        ...(entry.builtin ? { builtin: true as const } : {})
      }
    })
}

export type NativeChatSessionSkill = Pick<
  AgentSessionSlashCommand,
  'name' | 'description' | 'path' | 'argumentHint'
>

function isSessionSkill(entry: AgentSessionSlashCommand, agent?: AgentType): boolean {
  return (
    entry.kind === 'skill' ||
    (agent === 'omp' && entry.name.startsWith('skill:') && entry.name.length > 'skill:'.length)
  )
}

export function sessionReportedSkills(
  reported: readonly AgentSessionSlashCommand[],
  agent?: AgentType
): readonly NativeChatSessionSkill[] {
  return reported.flatMap((entry) =>
    isSessionSkill(entry, agent)
      ? [
          {
            name: entry.name,
            ...(entry.description ? { description: entry.description } : {}),
            ...(entry.path ? { path: entry.path } : {}),
            ...(entry.argumentHint ? { argumentHint: entry.argumentHint } : {})
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
