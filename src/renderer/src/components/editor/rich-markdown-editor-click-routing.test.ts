// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import type { MutableRefObject } from 'react'
import type { Editor } from '@tiptap/react'
import type { EditorView } from '@tiptap/pm/view'
import { handleRichMarkdownEditorClick } from './rich-markdown-editor-click-routing'

function createDocLinkClickOptions({
  event,
  isMac,
  nodeAt = () => ({
    type: { name: 'markdownDocLink' },
    attrs: { target: 'docs/setup-guide.md#Install steps' }
  })
}: {
  event: Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'>
  isMac: boolean
  nodeAt?: () => { type: { name: string }; attrs: Record<string, unknown> } | null
}): Parameters<typeof handleRichMarkdownEditorClick>[0] {
  const onOpenDocLink = vi.fn()
  const view = {
    state: {
      doc: {
        nodeAt
      }
    }
  } as unknown as EditorView

  return {
    activateMarkdownLink: vi.fn(),
    editorRef: { current: {} as Editor } as MutableRefObject<Editor | null>,
    event: event as MouseEvent,
    filePath: '/repo/current.md',
    isMac,
    markdownCommentsRef: { current: [] },
    markdownSourceLineOffsetRef: { current: 0 },
    onOpenDocLinkRef: { current: onOpenDocLink },
    pos: 1,
    rootRef: { current: null },
    scrollRichMarkdownReviewNoteCardIntoView: vi.fn(),
    settings: {},
    view,
    worktreeId: 'worktree-1',
    worktreeRoot: '/repo'
  }
}

describe('handleRichMarkdownEditorClick doc links', () => {
  it('opens doc links on Mac command-click', () => {
    const options = createDocLinkClickOptions({
      event: { metaKey: true, ctrlKey: false, shiftKey: false },
      isMac: true
    })

    expect(handleRichMarkdownEditorClick(options)).toBe(true)
    expect(options.onOpenDocLinkRef.current).toHaveBeenCalledWith(
      'docs/setup-guide.md#Install steps'
    )
  })

  it('opens doc links on non-Mac control-click', () => {
    const options = createDocLinkClickOptions({
      event: { metaKey: false, ctrlKey: true, shiftKey: false },
      isMac: false
    })

    expect(handleRichMarkdownEditorClick(options)).toBe(true)
    expect(options.onOpenDocLinkRef.current).toHaveBeenCalledWith(
      'docs/setup-guide.md#Install steps'
    )
  })

  it('opens doc links from the clicked node-view DOM target', () => {
    const docLink = document.createElement('span')
    docLink.setAttribute('data-doc-link-target', 'docs/dom-target.md')
    const label = document.createElement('span')
    docLink.appendChild(label)
    const event = new MouseEvent('click', { metaKey: true })
    Object.defineProperty(event, 'target', { value: label })
    const options = createDocLinkClickOptions({
      event,
      isMac: true,
      nodeAt: () => null
    })

    expect(handleRichMarkdownEditorClick(options)).toBe(true)
    expect(options.onOpenDocLinkRef.current).toHaveBeenCalledWith('docs/dom-target.md')
  })

  it('leaves plain clicks available for cursor placement', () => {
    const options = createDocLinkClickOptions({
      event: { metaKey: false, ctrlKey: false, shiftKey: false },
      isMac: true
    })

    expect(handleRichMarkdownEditorClick(options)).toBe(false)
    expect(options.onOpenDocLinkRef.current).not.toHaveBeenCalled()
  })
})
