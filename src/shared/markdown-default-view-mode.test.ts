import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MARKDOWN_DEFAULT_VIEW_MODE,
  isMarkdownDefaultViewMode,
  normalizeMarkdownDefaultViewMode
} from './markdown-default-view-mode'
import {
  markdownDefaultViewForCommand,
  richMarkdownDefaultViewCommands
} from './rich-markdown-context-menu'

describe('markdown default view mode', () => {
  it('keeps every supported view and rejects anything else', () => {
    expect(normalizeMarkdownDefaultViewMode('source')).toBe('source')
    expect(normalizeMarkdownDefaultViewMode('rich')).toBe('rich')
    expect(normalizeMarkdownDefaultViewMode('preview')).toBe('preview')
    expect(isMarkdownDefaultViewMode('changes')).toBe(false)
  })

  it('falls back to the rich editor for absent or malformed values', () => {
    expect(DEFAULT_MARKDOWN_DEFAULT_VIEW_MODE).toBe('rich')
    expect(normalizeMarkdownDefaultViewMode(undefined)).toBe('rich')
    expect(normalizeMarkdownDefaultViewMode('changes')).toBe('rich')
    expect(normalizeMarkdownDefaultViewMode(3)).toBe('rich')
  })
})

describe('markdownDefaultViewForCommand', () => {
  it('round-trips every default-view command', () => {
    expect(markdownDefaultViewForCommand(richMarkdownDefaultViewCommands.source)).toBe('source')
    expect(markdownDefaultViewForCommand(richMarkdownDefaultViewCommands.rich)).toBe('rich')
    expect(markdownDefaultViewForCommand(richMarkdownDefaultViewCommands.preview)).toBe('preview')
  })

  it('leaves formatting commands for the rich editor to run', () => {
    expect(markdownDefaultViewForCommand('bold')).toBeNull()
    expect(markdownDefaultViewForCommand('insert-row-above')).toBeNull()
  })
})
