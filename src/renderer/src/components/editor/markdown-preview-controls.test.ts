import { describe, expect, it } from 'vitest'
import {
  canOpenMarkdownPreview,
  getDefaultMarkdownViewMode,
  getMarkdownPreviewShortcutLabel,
  getMarkdownViewModes,
  isMarkdownPreviewShortcut
} from './markdown-preview-controls'

describe('getMarkdownViewModes', () => {
  it('offers source and rich for markdown edit tabs', () => {
    expect(
      getMarkdownViewModes({
        language: 'markdown',
        mode: 'edit'
      })
    ).toEqual(['source', 'rich'])
  })

  it('offers source and preview for single-file markdown diffs', () => {
    expect(
      getMarkdownViewModes({
        language: 'markdown',
        mode: 'diff',
        diffSource: 'unstaged'
      })
    ).toEqual(['source', 'preview'])
  })

  it('does not offer preview for mermaid edit tabs', () => {
    expect(
      getMarkdownViewModes({
        language: 'mermaid',
        mode: 'edit'
      })
    ).toEqual(['source', 'rich'])
  })
})

describe('markdown preview helpers', () => {
  it('defaults markdown edit tabs to rich mode', () => {
    expect(
      getDefaultMarkdownViewMode({
        language: 'markdown',
        mode: 'edit'
      })
    ).toBe('rich')
  })

  it('defaults markdown diffs to source mode', () => {
    expect(
      getDefaultMarkdownViewMode({
        language: 'markdown',
        mode: 'diff',
        diffSource: 'unstaged'
      })
    ).toBe('source')
  })

  it('opens dedicated preview tabs only for markdown edit tabs', () => {
    expect(
      canOpenMarkdownPreview({
        language: 'markdown',
        mode: 'edit'
      })
    ).toBe(true)
    expect(
      canOpenMarkdownPreview({
        language: 'markdown',
        mode: 'diff',
        diffSource: 'unstaged'
      })
    ).toBe(false)
  })

  it('matches the VS Code-style shortcut on macOS and Windows/Linux', () => {
    expect(
      isMarkdownPreviewShortcut(
        {
          key: 'V',
          metaKey: true,
          ctrlKey: false,
          shiftKey: true,
          altKey: false
        } as KeyboardEvent,
        true
      )
    ).toBe(true)
    expect(
      isMarkdownPreviewShortcut(
        {
          key: 'v',
          metaKey: false,
          ctrlKey: true,
          shiftKey: true,
          altKey: false
        } as KeyboardEvent,
        false
      )
    ).toBe(true)
    expect(
      isMarkdownPreviewShortcut(
        {
          key: 'v',
          metaKey: false,
          ctrlKey: true,
          shiftKey: false,
          altKey: false
        } as KeyboardEvent,
        false
      )
    ).toBe(false)
  })

  it('formats the shortcut label per platform', () => {
    expect(getMarkdownPreviewShortcutLabel(true)).toBe('⌘⇧V')
    expect(getMarkdownPreviewShortcutLabel(false)).toBe('Ctrl+Shift+V')
  })
})
