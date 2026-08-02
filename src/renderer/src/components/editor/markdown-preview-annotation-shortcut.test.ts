// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import {
  getMarkdownAnnotationBlockKeyForSelection,
  isMarkdownPreviewAddReviewNoteShortcut,
  previewHasAnnotationBlockKey,
  resolveMarkdownPreviewAddReviewNoteKey
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

describe('resolveMarkdownPreviewAddReviewNoteKey', () => {
  const chord = {
    key: 'a',
    code: 'KeyA',
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: true,
    repeat: false
  }

  it('consumes the chord while a mounted draft block is open (product B)', () => {
    const { root } = createPreviewFixture()

    expect(
      resolveMarkdownPreviewAddReviewNoteKey({
        event: chord,
        platform: 'darwin',
        targetInsidePreview: true,
        markdownAnnotationsEnabled: true,
        activeAnnotationBlockKey: 'p:3-5',
        root,
        selection: null
      })
    ).toEqual({ action: 'consume' })
  })

  it('consumes OS key-repeat while a mounted draft is open', () => {
    const { root } = createPreviewFixture()

    expect(
      resolveMarkdownPreviewAddReviewNoteKey({
        event: { ...chord, repeat: true },
        platform: 'darwin',
        targetInsidePreview: true,
        markdownAnnotationsEnabled: true,
        activeAnnotationBlockKey: 'p:3-5',
        root,
        selection: null
      })
    ).toEqual({ action: 'consume' })
  })

  it('ignores OS key-repeat when no draft is open', () => {
    const { root, paragraph } = createPreviewFixture()
    const selection = selectTextIn(paragraph)

    expect(
      resolveMarkdownPreviewAddReviewNoteKey({
        event: { ...chord, repeat: true },
        platform: 'darwin',
        targetInsidePreview: true,
        markdownAnnotationsEnabled: true,
        activeAnnotationBlockKey: null,
        root,
        selection
      })
    ).toEqual({ action: 'ignore' })
  })

  it('opens the composer for a live selection when no draft is open', () => {
    const { root, paragraph } = createPreviewFixture()
    const selection = selectTextIn(paragraph)

    expect(
      resolveMarkdownPreviewAddReviewNoteKey({
        event: chord,
        platform: 'darwin',
        targetInsidePreview: true,
        markdownAnnotationsEnabled: true,
        activeAnnotationBlockKey: null,
        root,
        selection
      })
    ).toEqual({ action: 'open', blockKey: 'p:3-5' })
  })

  it('clears a stale block key that no longer mounts a composer', () => {
    const { root, paragraph } = createPreviewFixture()
    const selection = selectTextIn(paragraph)

    expect(previewHasAnnotationBlockKey(root, 'p:9-9')).toBe(false)
    expect(
      resolveMarkdownPreviewAddReviewNoteKey({
        event: chord,
        platform: 'darwin',
        targetInsidePreview: true,
        markdownAnnotationsEnabled: true,
        activeAnnotationBlockKey: 'p:9-9',
        root,
        selection
      })
    ).toEqual({ action: 'open', blockKey: 'p:3-5' })
  })

  it('clears a stale key on repeat without opening', () => {
    const { root } = createPreviewFixture()

    expect(
      resolveMarkdownPreviewAddReviewNoteKey({
        event: { ...chord, repeat: true },
        platform: 'darwin',
        targetInsidePreview: true,
        markdownAnnotationsEnabled: true,
        activeAnnotationBlockKey: 'p:9-9',
        root,
        selection: null
      })
    ).toEqual({ action: 'clear-stale-and-ignore' })
  })
})
