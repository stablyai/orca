import { translate } from '@/i18n/i18n'
import type { SlashCommandDescriptionCopy } from './native-chat-slash-command-descriptions'

export const CODEX_SLASH_COMMAND_DESCRIPTIONS: SlashCommandDescriptionCopy = {
  clear: {
    'Clear the terminal and start a new chat': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.clearTerminal',
        'Clear the terminal and start a new chat'
      )
  },
  compact: {
    'Compact the conversation': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.compactConversation',
        'Compact the conversation'
      )
  },
  init: {
    'Create an AGENTS.md file': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.initAgents',
        'Create an AGENTS.md file'
      )
  },
  model: {
    'Choose the model and reasoning effort': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.modelAndEffort',
        'Choose the model and reasoning effort'
      )
  },
  ide: {
    'Include IDE context': () =>
      translate('components.native-chat.slashCommandDescriptions.ide', 'Include IDE context')
  },
  permissions: {
    'Choose what Codex is allowed to do': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.permissions',
        'Choose what Codex is allowed to do'
      )
  },
  keymap: {
    'Remap TUI shortcuts': () =>
      translate('components.native-chat.slashCommandDescriptions.keymap', 'Remap TUI shortcuts')
  },
  vim: {
    'Toggle Vim mode': () =>
      translate('components.native-chat.slashCommandDescriptions.vim', 'Toggle Vim mode')
  },
  experimental: {
    'Toggle experimental features': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.experimental',
        'Toggle experimental features'
      )
  },
  approve: {
    'Approve one auto-review retry': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.approve',
        'Approve one auto-review retry'
      )
  },
  memories: {
    'Configure memory use': () =>
      translate('components.native-chat.slashCommandDescriptions.memories', 'Configure memory use')
  },
  skills: {
    'Manage and use skills': () =>
      translate('components.native-chat.slashCommandDescriptions.skills', 'Manage and use skills')
  },
  import: {
    'Import setup from Claude Code': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.import',
        'Import setup from Claude Code'
      )
  },
  hooks: {
    'View lifecycle hooks': () =>
      translate('components.native-chat.slashCommandDescriptions.hooks', 'View lifecycle hooks')
  },
  rename: {
    'Rename the current thread': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.renameThread',
        'Rename the current thread'
      )
  },
  new: {
    'Start a new chat': () =>
      translate('components.native-chat.slashCommandDescriptions.newChat', 'Start a new chat')
  },
  archive: {
    'Archive this session and exit': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.archive',
        'Archive this session and exit'
      )
  },
  delete: {
    'Delete this session and exit': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.delete',
        'Delete this session and exit'
      )
  },
  resume: {
    'Resume a saved chat': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.resumeSaved',
        'Resume a saved chat'
      )
  },
  fork: {
    'Fork the current chat': () =>
      translate('components.native-chat.slashCommandDescriptions.forkChat', 'Fork the current chat')
  },
  app: {
    'Continue in Codex Desktop': () =>
      translate('components.native-chat.slashCommandDescriptions.app', 'Continue in Codex Desktop')
  },
  plan: {
    'Switch to Plan mode': () =>
      translate('components.native-chat.slashCommandDescriptions.planSwitch', 'Switch to Plan mode')
  },
  goal: {
    'Set or view the goal': () =>
      translate('components.native-chat.slashCommandDescriptions.goal', 'Set or view the goal')
  },
  agent: {
    'Switch the active agent thread': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.agent',
        'Switch the active agent thread'
      )
  },
  subagents: {
    'Switch the active agent thread': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.subagents',
        'Switch the active agent thread'
      )
  },
  side: {
    'Start a side conversation': () =>
      translate('components.native-chat.slashCommandDescriptions.side', 'Start a side conversation')
  },
  copy: {
    'Copy the last response as markdown': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.copy',
        'Copy the last response as markdown'
      )
  },
  raw: {
    'Toggle raw scrollback mode': () =>
      translate('components.native-chat.slashCommandDescriptions.raw', 'Toggle raw scrollback mode')
  },
  diff: {
    'Show the working diff': () =>
      translate('components.native-chat.slashCommandDescriptions.diff', 'Show the working diff')
  },
  mention: {
    'Mention a file': () =>
      translate('components.native-chat.slashCommandDescriptions.mention', 'Mention a file')
  },
  status: {
    'Show session configuration and usage': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.status',
        'Show session configuration and usage'
      )
  },
  usage: {
    'View account usage': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.usageAccount',
        'View account usage'
      )
  },
  title: {
    'Configure the terminal title': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.title',
        'Configure the terminal title'
      )
  },
  statusline: {
    'Configure the status line': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.statusline',
        'Configure the status line'
      )
  },
  theme: {
    'Choose a syntax highlighting theme': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.theme',
        'Choose a syntax highlighting theme'
      )
  },
  pets: {
    'Choose or hide the terminal pet': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.pets',
        'Choose or hide the terminal pet'
      )
  },
  mcp: {
    'List configured MCP tools': () =>
      translate('components.native-chat.slashCommandDescriptions.mcp', 'List configured MCP tools')
  },
  plugins: {
    'Browse plugins': () =>
      translate('components.native-chat.slashCommandDescriptions.plugins', 'Browse plugins')
  },
  logout: {
    'Log out of Codex': () =>
      translate('components.native-chat.slashCommandDescriptions.logout', 'Log out of Codex')
  },
  exit: {
    'Exit Codex': () =>
      translate('components.native-chat.slashCommandDescriptions.exit', 'Exit Codex')
  },
  feedback: {
    'Send logs to maintainers': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.feedback',
        'Send logs to maintainers'
      )
  },
  ps: {
    'List background terminals': () =>
      translate('components.native-chat.slashCommandDescriptions.ps', 'List background terminals')
  },
  stop: {
    'Stop all background terminals': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.stop',
        'Stop all background terminals'
      )
  },
  personality: {
    'Choose a communication style': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.personality',
        'Choose a communication style'
      )
  }
}
