import { translate } from '@/i18n/i18n'
import type { SlashCommandDescriptionCopy } from './native-chat-slash-command-descriptions'

export const OMP_SLASH_COMMAND_DESCRIPTIONS: SlashCommandDescriptionCopy = {
  clear: {
    'Clear context while keeping the session': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.clearKeepSession',
        'Clear context while keeping the session'
      )
  },
  context: {
    'Show estimated context usage': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.contextEstimated',
        'Show estimated context usage'
      )
  },
  model: {
    'Open the model selector in Terminal': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.modelTerminal',
        'Open the model selector in Terminal'
      )
  },
  rename: {
    'Rename the session': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.renameSession',
        'Rename the session'
      )
  },
  new: {
    'Start a new session': () =>
      translate('components.native-chat.slashCommandDescriptions.newSession', 'Start a new session')
  },
  resume: {
    'Resume a session; without arguments, choose in Terminal': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.resumeSession',
        'Resume a session; without arguments, choose in Terminal'
      )
  },
  fork: {
    'Fork from a previous message in Terminal': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.forkMessage',
        'Fork from a previous message in Terminal'
      )
  },
  plan: {
    'Toggle plan mode': () =>
      translate('components.native-chat.slashCommandDescriptions.planToggle', 'Toggle plan mode')
  },
  usage: {
    'Show provider usage and limits': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.usageProvider',
        'Show provider usage and limits'
      )
  },
  switch: {
    'Open the temporary model selector in Terminal': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.switch',
        'Open the temporary model selector in Terminal'
      )
  },
  branch: {
    'Rewind to a previous message in Terminal': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.branch',
        'Rewind to a previous message in Terminal'
      )
  },
  tree: {
    'Browse the session tree in Terminal': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.tree',
        'Browse the session tree in Terminal'
      )
  },
  session: {
    'Show session information and controls': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.session',
        'Show session information and controls'
      )
  },
  fast: {
    'Toggle priority service tier': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.fast',
        'Toggle priority service tier'
      )
  },
  tools: {
    'Show tools visible to the agent': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.tools',
        'Show tools visible to the agent'
      )
  },
  jobs: {
    'Show background jobs': () =>
      translate('components.native-chat.slashCommandDescriptions.jobs', 'Show background jobs')
  },
  git: {
    'Open the Git viewer in Terminal': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.git',
        'Open the Git viewer in Terminal'
      )
  },
  export: {
    'Export the session to HTML': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.export',
        'Export the session to HTML'
      )
  },
  settings: {
    'Open settings in Terminal': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.settings',
        'Open settings in Terminal'
      )
  },
  extensions: {
    'Open the extension dashboard in Terminal': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.extensions',
        'Open the extension dashboard in Terminal'
      )
  },
  hotkeys: {
    'Show keyboard shortcuts in Terminal': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.hotkeys',
        'Show keyboard shortcuts in Terminal'
      )
  }
}
