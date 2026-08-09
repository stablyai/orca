// @vitest-environment happy-dom

import type { MutableRefObject } from 'react'
import type { Editor } from '@tiptap/react'
import type { EditorView } from '@tiptap/pm/view'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import { createRichMarkdownHtmlSuperscriptLinkContext } from './rich-markdown-html-superscript-link-context'

const getCommentAtPosition = vi.hoisted(() => vi.fn())
const openHttpLink = vi.hoisted(() => vi.fn())

vi.mock('./rich-markdown-review-annotations', () => ({
  getRichMarkdownCommentAtPos: getCommentAtPosition
}))
vi.mock('@/lib/http-link-routing', () => ({ openHttpLink }))

import {
  handleRichMarkdownEditorClick,
  type ActivateMarkdownLink
} from './rich-markdown-editor-click-routing'

type ClickNode = {
  attrs: Record<string, unknown>
  type: { name: string }
}

const baseEvent = {
  button: 0,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false
} as MouseEvent

function ref<T>(current: T): MutableRefObject<T> {
  return { current }
}

function editorView(node: ClickNode | null, href?: string): EditorView {
  return {
    state: {
      doc: {
        nodeAt: () => node,
        resolve: () => ({
          marks: () =>
            href
              ? [
                  {
                    attrs: { href },
                    type: { name: 'link' }
                  }
                ]
              : []
        })
      }
    }
  } as unknown as EditorView
}

function routeClick({
  activateMarkdownLink = vi.fn(),
  event = baseEvent,
  followLinksOnClick = false,
  href,
  isMac = false,
  node = null,
  onOpenDocLink = vi.fn(),
  sourceOwner = { kind: 'ssh', connectionId: 'ssh-1' }
}: {
  activateMarkdownLink?: ActivateMarkdownLink
  event?: MouseEvent
  followLinksOnClick?: boolean
  href?: string
  isMac?: boolean
  node?: ClickNode | null
  onOpenDocLink?: (target: string) => void
  sourceOwner?: HttpLinkSourceOwner
}): boolean {
  return handleRichMarkdownEditorClick({
    activateMarkdownLink,
    editorRef: ref({} as Editor),
    event,
    filePath: '/repo/docs/start.md',
    followLinksOnClickRef: ref(followLinksOnClick),
    htmlSuperscriptLinkContext: createRichMarkdownHtmlSuperscriptLinkContext({
      sourceFilePath: '/repo/docs/start.md',
      worktreeId: 'worktree-1',
      worktreeRoot: '/repo',
      sourceOwner
    }),
    isMac,
    markdownCommentsRef: ref([]),
    markdownSourceLineOffsetRef: ref(0),
    onOpenDocLinkRef: ref(onOpenDocLink),
    pos: 1,
    rootRef: ref(null),
    runtimeEnvironmentId: null,
    scrollRichMarkdownReviewNoteCardIntoView: vi.fn(),
    settings: { activeRuntimeEnvironmentId: null },
    view: editorView(node, href),
    worktreeId: 'worktree-1',
    worktreeRoot: '/repo'
  })
}

describe('handleRichMarkdownEditorClick Follow links routing', () => {
  beforeEach(() => {
    getCommentAtPosition.mockReset()
    getCommentAtPosition.mockReturnValue(null)
    openHttpLink.mockReset()
  })

  it('keeps a plain standard-link click editable when Follow links is off', () => {
    const activateMarkdownLink = vi.fn()

    expect(routeClick({ activateMarkdownLink, href: './next.md' })).toBe(false)
    expect(activateMarkdownLink).not.toHaveBeenCalled()
  })

  it('activates a plain standard link with its SSH owner when Follow links is on', () => {
    const activateMarkdownLink = vi.fn()

    expect(
      routeClick({
        activateMarkdownLink,
        followLinksOnClick: true,
        href: './next.md'
      })
    ).toBe(true)
    expect(activateMarkdownLink).toHaveBeenCalledWith('./next.md', {
      sourceFilePath: '/repo/docs/start.md',
      worktreeId: 'worktree-1',
      worktreeRoot: '/repo',
      runtimeEnvironmentId: null,
      sourceOwner: { kind: 'ssh', connectionId: 'ssh-1' }
    })
  })

  it('uses the clicked anchor when the document position is at a mark boundary', () => {
    const activateMarkdownLink = vi.fn()
    const anchor = document.createElement('a')
    anchor.setAttribute('href', './next.md')

    expect(
      routeClick({
        activateMarkdownLink,
        event: { ...baseEvent, target: anchor } as MouseEvent,
        followLinksOnClick: true
      })
    ).toBe(true)
    expect(activateMarkdownLink).toHaveBeenCalledWith('./next.md', expect.any(Object))
  })

  it.each([
    { name: 'Cmd on macOS', isMac: true, event: { ...baseEvent, metaKey: true } as MouseEvent },
    {
      name: 'Ctrl on Linux and Windows',
      isMac: false,
      event: { ...baseEvent, ctrlKey: true } as MouseEvent
    }
  ])('activates a standard link with $name', ({ event, isMac }) => {
    const activateMarkdownLink = vi.fn()

    expect(routeClick({ activateMarkdownLink, event, href: './next.md', isMac })).toBe(true)
    expect(activateMarkdownLink).toHaveBeenCalledWith('./next.md', expect.any(Object))
  })

  it('keeps modifier activation for images and document links', () => {
    const activateMarkdownLink = vi.fn()
    const onOpenDocLink = vi.fn()
    const event = { ...baseEvent, ctrlKey: true } as MouseEvent

    expect(
      routeClick({
        activateMarkdownLink,
        event,
        node: { type: { name: 'image' }, attrs: { src: './image.png' } }
      })
    ).toBe(true)
    expect(activateMarkdownLink).toHaveBeenCalledWith('./image.png', expect.any(Object))

    expect(
      routeClick({
        event,
        node: { type: { name: 'markdownDocLink' }, attrs: { target: 'wiki-note' } },
        onOpenDocLink
      })
    ).toBe(true)
    expect(onOpenDocLink).toHaveBeenCalledWith('wiki-note')
  })

  it.each([
    {
      event: { ...baseEvent, metaKey: true, shiftKey: true } as MouseEvent,
      isMac: true,
      name: 'Cmd+Shift on macOS',
      sourceOwner: { kind: 'local' } as HttpLinkSourceOwner
    },
    {
      event: { ...baseEvent, ctrlKey: true, shiftKey: true } as MouseEvent,
      isMac: false,
      name: 'Ctrl+Shift on Linux and Windows',
      sourceOwner: { kind: 'ssh', connectionId: 'ssh-1' } as HttpLinkSourceOwner
    }
  ])('keeps $name as the client-OS escape for standard links', ({ event, isMac, sourceOwner }) => {
    expect(
      routeClick({
        event,
        href: 'https://example.com',
        isMac,
        sourceOwner
      })
    ).toBe(true)
    expect(openHttpLink).toHaveBeenCalledWith('https://example.com/', {
      forceSystemBrowser: true,
      sourceOwner
    })
  })

  it.each([
    { name: 'image', attrs: { src: './image.png' } },
    { name: 'markdownDocLink', attrs: { target: 'wiki-note' } },
    {
      name: 'richMarkdownHtmlSuperscriptLink',
      attrs: { href: 'https://example.com/citation' }
    }
  ])('keeps plain $name clicks modifier-only', ({ name, attrs }) => {
    const activateMarkdownLink = vi.fn()
    const onOpenDocLink = vi.fn()

    expect(
      routeClick({
        activateMarkdownLink,
        followLinksOnClick: true,
        node: { type: { name }, attrs },
        onOpenDocLink
      })
    ).toBe(false)
    expect(activateMarkdownLink).not.toHaveBeenCalled()
    expect(onOpenDocLink).not.toHaveBeenCalled()
  })

  it('preserves review-note selection for a plain non-link click', () => {
    const scrollIntoView = vi.fn()
    getCommentAtPosition.mockReturnValue({ id: 'comment-1' })

    const handled = handleRichMarkdownEditorClick({
      activateMarkdownLink: vi.fn(),
      editorRef: ref({} as Editor),
      event: baseEvent,
      filePath: '/repo/docs/start.md',
      followLinksOnClickRef: ref(true),
      htmlSuperscriptLinkContext: createRichMarkdownHtmlSuperscriptLinkContext({
        sourceFilePath: '/repo/docs/start.md',
        worktreeId: 'worktree-1',
        worktreeRoot: '/repo',
        sourceOwner: { kind: 'local' }
      }),
      isMac: false,
      markdownCommentsRef: ref([]),
      markdownSourceLineOffsetRef: ref(0),
      onOpenDocLinkRef: ref(undefined),
      pos: 1,
      rootRef: ref(null),
      runtimeEnvironmentId: null,
      scrollRichMarkdownReviewNoteCardIntoView: scrollIntoView,
      settings: { activeRuntimeEnvironmentId: null },
      view: editorView(null),
      worktreeId: 'worktree-1',
      worktreeRoot: '/repo'
    })

    expect(handled).toBe(false)
    expect(scrollIntoView).toHaveBeenCalledWith('comment-1')
  })
})
