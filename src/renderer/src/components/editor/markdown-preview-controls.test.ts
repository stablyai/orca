import { describe, expect, it } from 'vitest'
import {
  canOpenMarkdownPreview,
  getDefaultMarkdownViewMode,
  getEditorToggleModes,
  getMarkdownViewModes,
  isMarkdownPreviewShortcut
} from './markdown-preview-controls'

describe('getMarkdownViewModes', () => {
  it('offers source, rich, and preview for markdown edit tabs', () => {
    expect(
      getMarkdownViewModes({
        language: 'markdown',
        mode: 'edit'
      })
    ).toEqual(['source', 'rich', 'preview'])
  })

  it('offers source and rich for single-file markdown diffs', () => {
    expect(
      getMarkdownViewModes({
        language: 'markdown',
        mode: 'diff',
        diffSource: 'unstaged'
      })
    ).toEqual(['source', 'rich'])
  })

  it('does not offer preview for mermaid edit tabs', () => {
    expect(
      getMarkdownViewModes({
        language: 'mermaid',
        mode: 'edit'
      })
    ).toEqual(['source', 'rich'])
  })

  it('keeps notebook toggles to source and rich without Changes', () => {
    expect(
      getEditorToggleModes({
        language: 'notebook',
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

  it('opens markdown edit tabs in the preferred view', () => {
    expect(getDefaultMarkdownViewMode({ language: 'markdown', mode: 'edit' }, 'preview')).toBe(
      'preview'
    )
    expect(getDefaultMarkdownViewMode({ language: 'markdown', mode: 'edit' }, 'source')).toBe(
      'source'
    )
  })

  it('ignores the preference on surfaces whose rich slot is not a markdown view', () => {
    expect(getDefaultMarkdownViewMode({ language: 'csv', mode: 'edit' }, 'preview')).toBe('rich')
    expect(getDefaultMarkdownViewMode({ language: 'mermaid', mode: 'edit' }, 'source')).toBe('rich')
    expect(
      getDefaultMarkdownViewMode(
        { language: 'markdown', mode: 'diff', diffSource: 'unstaged' },
        'preview'
      )
    ).toBe('source')
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
        'darwin'
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
        'linux'
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
        'linux'
      )
    ).toBe(false)
  })
})
