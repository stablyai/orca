import { describe, expect, it } from 'vitest'
import { localizeSlashCommandDescription } from './native-chat-slash-command-descriptions'

describe('localizeSlashCommandDescription', () => {
  it('localizes shared slash command descriptions including mcp', () => {
    expect(localizeSlashCommandDescription('mcp', 'List configured MCP tools')).toBe(
      'List configured MCP tools'
    )
    expect(
      localizeSlashCommandDescription('mcp', 'List configured MCP tools and servers')
    ).toBe('List configured MCP tools')
    expect(localizeSlashCommandDescription('review', 'Review the current changes')).toBe(
      'Review the current changes'
    )
  })

  it('passes through unknown or custom descriptions', () => {
    expect(localizeSlashCommandDescription('mcp', 'Custom MCP description')).toBe(
      'Custom MCP description'
    )
    expect(localizeSlashCommandDescription('custom', 'Custom command')).toBe('Custom command')
    expect(localizeSlashCommandDescription('clear', undefined)).toBeUndefined()
  })
})
