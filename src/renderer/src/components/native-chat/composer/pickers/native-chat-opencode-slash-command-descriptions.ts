import { translate } from '@/i18n/i18n'
import type { SlashCommandDescriptionCopy } from './native-chat-slash-command-descriptions'

export const OPENCODE_SLASH_COMMAND_DESCRIPTIONS: SlashCommandDescriptionCopy = {
  models: {
    'Open the model selector in Terminal': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.modelTerminal',
        'Open the model selector in Terminal'
      )
  },
  agents: {
    'Choose the agent in Terminal': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.agentsTerminal',
        'Choose the agent in Terminal'
      )
  },
  sessions: {
    'Switch sessions in Terminal': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.sessionsTerminal',
        'Switch sessions in Terminal'
      )
  },
  skills: {
    'Browse skills in Terminal': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.skillsTerminal',
        'Browse skills in Terminal'
      )
  },
  mcps: {
    'Manage MCP servers in Terminal': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.mcpsTerminal',
        'Manage MCP servers in Terminal'
      )
  },
  connect: {
    'Connect a provider in Terminal': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.connectTerminal',
        'Connect a provider in Terminal'
      )
  },
  status: {
    'View status in Terminal': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.statusTerminal',
        'View status in Terminal'
      )
  },
  themes: {
    'Choose a theme in Terminal': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.themesTerminal',
        'Choose a theme in Terminal'
      )
  },
  diff: {
    'Open the diff viewer in Terminal': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.diffTerminal',
        'Open the diff viewer in Terminal'
      )
  },
  editor: {
    'Open your editor in Terminal': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.editorTerminal',
        'Open your editor in Terminal'
      )
  },
  debug: {
    'View debug info in Terminal': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.debugTerminal',
        'View debug info in Terminal'
      )
  },
  help: {
    'Show help in Terminal': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.helpTerminal',
        'Show help in Terminal'
      )
  },
  fork: {
    'Fork the session in Terminal': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.forkSessionTerminal',
        'Fork the session in Terminal'
      )
  },
  rename: {
    'Rename the session in Terminal': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.renameSessionTerminal',
        'Rename the session in Terminal'
      )
  },
  timeline: {
    'Browse the session timeline in Terminal': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.timelineTerminal',
        'Browse the session timeline in Terminal'
      )
  },
  export: {
    'Export the session in Terminal': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.exportTerminal',
        'Export the session in Terminal'
      )
  }
}
