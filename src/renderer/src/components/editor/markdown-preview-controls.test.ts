import { describe, expect, it } from 'vitest'
import {
  canOpenMarkdownPreview,
  getDefaultMarkdownViewMode,
  getEditorToggleModes,
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

describe('getEditorToggleModes rich-mode fallback', () => {
  it('offers Preview alongside Source and Rich when rich mode falls back for this content', () => {
    expect(
      getEditorToggleModes({
        language: 'markdown',
        mode: 'edit',
        richModeFallsBackToSource: true
      })
    ).toEqual(['source', 'rich', 'preview', 'changes'])
  })

  it('omits Preview when rich mode renders normally', () => {
    expect(
      getEditorToggleModes({
        language: 'markdown',
        mode: 'edit',
        richModeFallsBackToSource: false
      })
    ).toEqual(['source', 'rich', 'changes'])
  })

  it('does not add Preview for non-markdown languages even when the flag is set', () => {
    expect(
      getEditorToggleModes({
        language: 'mermaid',
        mode: 'edit',
        richModeFallsBackToSource: true
      })
    ).toEqual(['source', 'rich', 'changes'])
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
