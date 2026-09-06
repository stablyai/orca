// Single source of truth for native chat slash-command behavior, shared by the
// desktop renderer and the mobile app. This is pure data + string helpers (no
// DOM, no RN-only imports), so both platforms import the SAME values — no
// mirrored copy to drift, unlike the agent-specific parsers in src/shared that
// Metro forces us to duplicate.

import type { AgentType } from './agent-status-types'

export type SlashCommandSuggestion = {
  /** The command token without its leading slash, e.g. `clear`. */
  name: string
  /** Optional one-line description for the suggestion row. */
  description?: string
}

// Best-effort, curated per-agent catalogs. The CLIs ship no machine-readable
// command list, so these track the common, stable commands each TUI documents.
// The composer treats commands as plain data, so this can grow freely.

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

const OPENCODE_COMMANDS: readonly SlashCommandSuggestion[] = [
  { name: 'new', description: 'Start a new session' },
  { name: 'models', description: 'Choose a model' },
  { name: 'sessions', description: 'Browse sessions' },
  { name: 'compact', description: 'Compact the conversation' },
  { name: 'init', description: 'Create or update project instructions' },
  { name: 'undo', description: 'Undo the last message' },
  { name: 'redo', description: 'Redo the last undone message' },
  { name: 'editor', description: 'Compose in an external editor' },
  { name: 'export', description: 'Export the conversation' },
  { name: 'share', description: 'Share the conversation' },
  { name: 'help', description: 'Show available commands' },
  { name: 'exit', description: 'Exit OpenCode' }
]

const KIMI_COMMANDS: readonly SlashCommandSuggestion[] = [
  { name: 'init', description: 'Generate an AGENTS.md file' },
  { name: 'compact', description: 'Compact the context' },
  { name: 'clear', description: 'Clear the context' },
  { name: 'plan', description: 'Configure plan mode' },
  { name: 'add-dir', description: 'Add a workspace directory' },
  { name: 'model', description: 'Switch model or thinking mode' },
  { name: 'new', description: 'Start a new session' },
  { name: 'sessions', description: 'List or resume sessions' },
  { name: 'title', description: 'Set or show the session title' },
  { name: 'task', description: 'Browse background tasks' },
  { name: 'mcp', description: 'Show MCP servers and tools' },
  { name: 'hooks', description: 'List configured hooks' },
  { name: 'undo', description: 'Fork and retry a previous turn' },
  { name: 'fork', description: 'Fork the current session' },
  { name: 'export', description: 'Export the session to Markdown' },
  { name: 'import', description: 'Import context from a file or session' },
  { name: 'help', description: 'Show available commands' },
  { name: 'exit', description: 'Exit Kimi Code' }
]

const PI_COMMANDS: readonly SlashCommandSuggestion[] = [
  { name: 'model', description: 'Switch models' },
  { name: 'scoped-models', description: 'Configure model cycling' },
  { name: 'settings', description: 'Open settings' },
  { name: 'resume', description: 'Resume a previous session' },
  { name: 'new', description: 'Start a new session' },
  { name: 'name', description: 'Set the session name' },
  { name: 'session', description: 'Show session information' },
  { name: 'tree', description: 'Navigate the session tree' },
  { name: 'fork', description: 'Fork from a previous message' },
  { name: 'clone', description: 'Clone the active branch into a new session' },
  { name: 'compact', description: 'Compact the context' },
  { name: 'copy', description: 'Copy the last assistant response' },
  { name: 'export', description: 'Export the session' },
  { name: 'import', description: 'Import and resume a session' },
  { name: 'share', description: 'Share the session as a private gist' },
  { name: 'reload', description: 'Reload configuration and resources' },
  { name: 'hotkeys', description: 'Show keyboard shortcuts' },
  { name: 'changelog', description: 'Show version history' },
  { name: 'quit', description: 'Exit Pi' }
]

const GROK_COMMANDS: readonly SlashCommandSuggestion[] = [
  { name: 'workflows', description: 'Show workflow runs' },
  { name: 'new', description: 'Start a new session' },
  { name: 'compact', description: 'Compact the conversation' },
  { name: 'copy', description: 'Copy the last response' },
  { name: 'memory', description: 'Manage memory' },
  { name: 'resume', description: 'Resume a session' },
  { name: 'session-info', description: 'Show session information' },
  { name: 'usage', description: 'Show usage information' },
  { name: 'help', description: 'Browse commands and shortcuts' },
  { name: 'docs', description: 'Open Grok documentation' },
  { name: 'home', description: 'Return to the welcome screen' },
  { name: 'quit', description: 'Exit Grok' }
]

const COMMANDS_BY_AGENT: Partial<Record<AgentType, readonly SlashCommandSuggestion[]>> = {
  claude: CLAUDE_COMMANDS,
  openclaude: CLAUDE_COMMANDS,
  codex: CODEX_COMMANDS,
  opencode: OPENCODE_COMMANDS,
  kimi: KIMI_COMMANDS,
  pi: PI_COMMANDS,
  grok: GROK_COMMANDS
}

/** Known slash commands for an agent, falling back to a small common set so the
 *  `/` menu is never empty for a recognized agent. */
export function getAgentSlashCommands(agent: AgentType): readonly SlashCommandSuggestion[] {
  return COMMANDS_BY_AGENT[agent] ?? COMMON_COMMANDS
}

/** Whether the draft is a slash command (leading `/`, ignoring leading space).
 *  Slash drafts dispatch to the agent's own TUI and must NOT render an optimistic
 *  user bubble — they are control actions, not chat turns. */
export function isSlashCommandDraft(draft: string): boolean {
  return draft.trimStart().startsWith('/')
}

/** Case-insensitive prefix filter over an agent's commands. An empty query
 *  returns all commands so a bare `/` shows the full menu. */
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

/** Replace the slash token with the chosen command plus a trailing space, so the
 *  user can type arguments. This is the Tab-completion path. */
export function applySlashSuggestion(command: SlashCommandSuggestion): string {
  return `/${command.name} `
}

/** Text to send when Enter accepts a slash command from the menu — no trailing
 *  space, because the TUI dispatches the command on Enter. */
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
  // Why: the supported TUIs only treat a line-leading token as a command, so a
  // draft with leading whitespace is prose; trimming here would claim a "Ran"
  // line for text the agent never dispatched.
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
  // Why: `$` is Codex grammar only. For other agents a leading `$PATH`-style
  // token is ordinary prose and must keep its bubble and attachments.
  if (skillPrefix === '$' && firstToken.startsWith('$')) {
    return 'unknown-token'
  }
  return 'chat'
}
