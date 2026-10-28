import { translate } from '@/i18n/i18n'
import { CODEX_SLASH_COMMAND_DESCRIPTIONS } from './native-chat-codex-slash-command-descriptions'
import { OMP_SLASH_COMMAND_DESCRIPTIONS } from './native-chat-omp-slash-command-descriptions'

/** Command name -> curated English description -> localized copy. */
export type SlashCommandDescriptionCopy = Record<string, Record<string, () => string>>

const SHARED_SLASH_COMMAND_DESCRIPTIONS: SlashCommandDescriptionCopy = {
  clear: {
    'Clear the conversation': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.clearConversation',
        'Clear the conversation'
      ),
    'Clear conversation history': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.clearHistory',
        'Clear conversation history'
      ),
    'Clear conversation context': () =>
      translate('components.native-chat.composer.clearDescription', 'Clear conversation context')
  },
  help: {
    'Show available commands': () =>
      translate('components.native-chat.slashCommandDescriptions.help', 'Show available commands')
  },
  compact: {
    'Summarize and compact the conversation': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.compactSummarize',
        'Summarize and compact the conversation'
      ),
    'Compact conversation context': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.compactContext',
        'Compact conversation context'
      )
  },
  init: {
    'Initialize a CLAUDE.md': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.initClaude',
        'Initialize a CLAUDE.md'
      )
  },
  review: {
    'Review the current changes': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.review',
        'Review the current changes'
      )
  },
  context: {
    'Show context usage': () =>
      translate(
        'components.native-chat.slashCommandDescriptions.contextUsage',
        'Show context usage'
      )
  },
  model: {
    'Choose the model': () =>
      translate('components.native-chat.slashCommandDescriptions.model', 'Choose the model')
  },
  effort: {
    'Choose reasoning effort': () =>
      translate('components.native-chat.slashCommandDescriptions.effort', 'Choose reasoning effort')
  }
}

const SLASH_COMMAND_DESCRIPTION_TABLES = [
  SHARED_SLASH_COMMAND_DESCRIPTIONS,
  CODEX_SLASH_COMMAND_DESCRIPTIONS,
  OMP_SLASH_COMMAND_DESCRIPTIONS
]

/** Localize curated descriptions by command name; agent-reported or older-host text passes through. */
export function localizeSlashCommandDescription(
  name: string,
  description: string | undefined
): string | undefined {
  if (!description) {
    return description
  }
  for (const table of SLASH_COMMAND_DESCRIPTION_TABLES) {
    const byDescription = Object.hasOwn(table, name) ? table[name] : undefined
    if (byDescription && Object.hasOwn(byDescription, description)) {
      return byDescription[description]()
    }
  }
  return description
}
