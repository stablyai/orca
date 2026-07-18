// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import {
  getMarkdownAnnotationBlockKeyForSelection,
  isMarkdownPreviewAddReviewNoteShortcut
} from './markdown-preview-annotation-shortcut'

function createPreviewFixture(): {
  root: HTMLDivElement
  block: HTMLDivElement
  paragraph: HTMLParagraphElement
} {
  const root = document.createElement('div')
  const block = document.createElement('div')
  block.className = 'markdown-annotation-block'
  block.setAttribute('data-annotation-block-key', 'p:3-5')
  const paragraph = document.createElement('p')
  paragraph.textContent = 'Some rendered markdown text'
  block.appendChild(paragraph)
  root.appendChild(block)
  document.body.appendChild(root)
  return { root, block, paragraph }
}

function selectTextIn(node: Node): Selection {
  const selection = window.getSelection()
  if (!selection) {
    throw new Error('Selection API unavailable in test environment')
  }
  const range = document.createRange()
  range.selectNodeContents(node)
  selection.removeAllRanges()
  selection.addRange(range)
  return selection
}

afterEach(() => {
  window.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

describe('getMarkdownAnnotationBlockKeyForSelection', () => {
  it('returns the block key for a selection inside an annotation block', () => {
    const { root, paragraph } = createPreviewFixture()
    const selection = selectTextIn(paragraph)

    expect(getMarkdownAnnotationBlockKeyForSelection(root, selection)).toBe('p:3-5')
  })

  it('returns null for a collapsed selection', () => {
    const { root, paragraph } = createPreviewFixture()
    const selection = selectTextIn(paragraph)
    selection.collapseToStart()

    expect(getMarkdownAnnotationBlockKeyForSelection(root, selection)).toBeNull()
  })

  it('returns null when the selection is outside the preview root', () => {
    const { root } = createPreviewFixture()
    const outside = document.createElement('p')
    outside.textContent = 'other text'
    document.body.appendChild(outside)
    const selection = selectTextIn(outside)

    expect(getMarkdownAnnotationBlockKeyForSelection(root, selection)).toBeNull()
  })

  it('returns null without a selection', () => {
    const { root } = createPreviewFixture()

    expect(getMarkdownAnnotationBlockKeyForSelection(root, null)).toBeNull()
  })
})

describe('isMarkdownPreviewAddReviewNoteShortcut', () => {
  it('matches the default binding and respects overrides', () => {
    const defaultEvent = {
      key: 'a',
      code: 'KeyA',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true
    }

    expect(isMarkdownPreviewAddReviewNoteShortcut(defaultEvent, 'darwin')).toBe(true)
    expect(isMarkdownPreviewAddReviewNoteShortcut(defaultEvent, 'linux')).toBe(false)
    expect(
      isMarkdownPreviewAddReviewNoteShortcut(
        { ...defaultEvent, metaKey: false, ctrlKey: true },
        'linux'
      )
    ).toBe(true)
    expect(
      isMarkdownPreviewAddReviewNoteShortcut(
        { ...defaultEvent, metaKey: false, ctrlKey: true },
        'win32'
      )
    ).toBe(true)
    expect(
      isMarkdownPreviewAddReviewNoteShortcut(defaultEvent, 'darwin', {
        'editor.addReviewNote': ['Mod+Shift+K']
      })
    ).toBe(false)
  })
})
