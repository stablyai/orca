import { describe, expect, it, vi } from 'vitest'

import type { SlashCommand } from './rich-markdown-slash-commands'
import {
  filterRichMarkdownSlashCommands,
  isRichMarkdownSlashCommandQueryTooLarge,
  RICH_MARKDOWN_SLASH_COMMAND_QUERY_MAX_BYTES
} from './rich-markdown-slash-command-filter'

function command(overrides: Partial<SlashCommand>): SlashCommand {
  return {
    id: 'text',
    label: 'Text',
    aliases: [],
    icon: { kind: 'text', value: 'T' },
    group: 'Basic blocks',
    description: 'Plain text',
    run: vi.fn(),
    ...overrides
  }
}

describe('filterRichMarkdownSlashCommands', () => {
  it('matches labels and aliases', () => {
    const commands = [
      command({ id: 'heading-1', label: 'Heading 1', aliases: ['h1', 'title'] }),
      command({ id: 'table', label: 'Table', aliases: ['grid'] })
    ]

    expect(filterRichMarkdownSlashCommands(commands, 'title').map((entry) => entry.id)).toEqual([
      'heading-1'
    ])
  })

  it('returns no commands for oversized pasted queries before reading commands', () => {
    const unreadableCommand = command({})
    Object.defineProperty(unreadableCommand, 'label', {
      get() {
        throw new Error('command should not be scanned')
      }
    })

    expect(
      filterRichMarkdownSlashCommands(
        [unreadableCommand],
        'x'.repeat(RICH_MARKDOWN_SLASH_COMMAND_QUERY_MAX_BYTES + 1)
      )
    ).toEqual([])
  })
})

describe('isRichMarkdownSlashCommandQueryTooLarge', () => {
  it('counts UTF-8 bytes rather than UTF-16 code units', () => {
    expect(
      isRichMarkdownSlashCommandQueryTooLarge(
        'é'.repeat(RICH_MARKDOWN_SLASH_COMMAND_QUERY_MAX_BYTES / 2 + 1)
      )
    ).toBe(true)
  })
})
