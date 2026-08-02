import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'
import type { SlashCommand } from './rich-markdown-slash-commands'

export const RICH_MARKDOWN_SLASH_COMMAND_QUERY_MAX_BYTES = 2 * 1024

export function isRichMarkdownSlashCommandQueryTooLarge(
  query: string,
  maxBytes = RICH_MARKDOWN_SLASH_COMMAND_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export function filterRichMarkdownSlashCommands(
  commands: readonly SlashCommand[],
  rawQuery: string
): SlashCommand[] {
  if (isRichMarkdownSlashCommandQueryTooLarge(rawQuery)) {
    return []
  }

  const query = rawQuery.trim().toLowerCase()
  if (!query) {
    return [...commands]
  }

  return commands.filter((command) => {
    const haystack = [command.label, ...command.aliases].join(' ').toLowerCase()
    return haystack.includes(query)
  })
}
