// @vitest-environment happy-dom

import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Editor } from '@tiptap/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createRichMarkdownEditorCodec } from '../document/rich-markdown-source-transport'
import { encodeRawMarkdownHtmlForRichEditor } from '../raw-source/raw-markdown-html'
import { createRichMarkdownExtensions } from '../schema/rich-markdown-extensions'
import { RichMarkdownLinkBubble, type LinkBubbleState } from './RichMarkdownLinkBubble'
import { useLinkBubble } from './useLinkBubble'

vi.mock('@/i18n/use-translate', () => ({
  useTranslate: () => (_key: string, fallback: string) => fallback
}))

describe('useLinkBubble hover and targetRange actions', () => {
  let container: HTMLDivElement
  let root: Root
  let editor: Editor | null = null

  afterEach(() => {
    vi.useRealTimers()
    editor?.destroy()
    editor = null
    act(() => root?.unmount())
    container?.remove()
    document.body.replaceChildren()
  })

  function mountEditorWithBubble(markdown: string): {
    editor: Editor
    wrapper: HTMLDivElement
  } {
    const codec = createRichMarkdownEditorCodec()
    const editorHost = document.createElement('div')
    const activeEditor = new Editor({
      element: editorHost,
      extensions: createRichMarkdownExtensions({ codec }),
      content: encodeRawMarkdownHtmlForRichEditor(markdown, codec),
      contentType: 'markdown'
    })
    editor = activeEditor

    function Harness(): React.JSX.Element {
      const rootRef = useRef<HTMLDivElement | null>(null)
      const [bubble, setBubble] = useState<LinkBubbleState | null>(null)
      const [isEditing, setIsEditing] = useState(false)
      const {
        handleLinkSave,
        handleLinkRemove,
        handleLinkEditCancel,
        handleLinkCopy,
        cancelHoverBubble,
        onBubblePointerEnter,
        onBubblePointerLeave
      } = useLinkBubble(activeEditor, rootRef, bubble, isEditing, setBubble, setIsEditing)

      return (
        <TooltipProvider>
          <div
            data-test-wrapper=""
            ref={(node) => {
              rootRef.current = node
              if (node && !node.contains(editorHost)) {
                node.appendChild(editorHost)
              }
            }}
          >
            {bubble ? (
              <RichMarkdownLinkBubble
                anchorElement={rootRef.current}
                linkBubble={bubble}
                isEditing={isEditing}
                onDismiss={() => {
                  cancelHoverBubble()
                  setBubble(null)
                  setIsEditing(false)
                }}
                onSave={handleLinkSave}
                onRemove={handleLinkRemove}
                onEditStart={() => {
                  cancelHoverBubble()
                  setIsEditing(true)
                }}
                onEditCancel={handleLinkEditCancel}
                onCopy={handleLinkCopy}
                onPointerEnter={onBubblePointerEnter}
                onPointerLeave={onBubblePointerLeave}
                portalToDocument
              />
            ) : null}
          </div>
        </TooltipProvider>
      )
    }

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root.render(<Harness />))
    const wrapper = container.querySelector<HTMLDivElement>('[data-test-wrapper]')
    if (!wrapper) {
      throw new Error('Expected wrapper element')
    }
    const rect = new DOMRect(0, 0, 400, 200)
    const rectList: DOMRectList = Object.assign([rect], {
      item: (index: number) => (index === 0 ? rect : null)
    })
    vi.spyOn(wrapper, 'getClientRects').mockReturnValue(rectList)
    return { editor: activeEditor, wrapper }
  }

  it('updates the hovered link when the caret is elsewhere', () => {
    vi.useFakeTimers()
    const { editor: activeEditor } = mountEditorWithBubble(
      'Intro paragraph\n\nVisit [docs](https://example.com) today'
    )
    activeEditor.commands.setTextSelection(2)
    const linkEl = activeEditor.view.dom.querySelector('a')
    if (!linkEl) {
      throw new Error('Expected rendered link')
    }

    act(() => {
      linkEl.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, buttons: 0 }))
    })
    act(() => {
      vi.advanceTimersByTime(160)
    })

    const bubbleEl = document.querySelector<HTMLElement>('[data-rich-markdown-link-bubble]')
    expect(bubbleEl).not.toBeNull()
    const editButton = bubbleEl!.querySelector<HTMLButtonElement>('button[aria-label="Edit link"]')!
    act(() => editButton.click())

    const input = document.querySelector<HTMLInputElement>(
      '[data-rich-markdown-link-bubble] input'
    )!
    expect(input.value).toBe('https://example.com')

    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(input, 'https://orca.dev/docs')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(activeEditor.getMarkdown()).toBe(
      'Intro paragraph\n\nVisit [docs](https://orca.dev/docs) today'
    )
  })

  it('dismisses a link edit when the document changes underneath its target range', () => {
    vi.useFakeTimers()
    const { editor: activeEditor } = mountEditorWithBubble(
      'Intro paragraph\n\nVisit [docs](https://example.com) today'
    )
    const linkEl = activeEditor.view.dom.querySelector('a')!
    act(() => {
      linkEl.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, buttons: 0 }))
      vi.advanceTimersByTime(160)
    })
    const editButton = document.querySelector<HTMLButtonElement>(
      '[data-rich-markdown-link-bubble] button[aria-label="Edit link"]'
    )!
    act(() => editButton.click())
    expect(document.querySelector('[data-rich-markdown-link-bubble] input')).not.toBeNull()

    act(() => {
      activeEditor.view.dispatch(activeEditor.state.tr.insertText('New ', 1))
    })

    expect(document.querySelector('[data-rich-markdown-link-bubble]')).toBeNull()
    expect(activeEditor.getMarkdown()).toBe(
      'New Intro paragraph\n\nVisit [docs](https://example.com) today'
    )
  })

  it('removes the hovered link mark even when the caret is in another paragraph', () => {
    vi.useFakeTimers()
    const { editor: activeEditor } = mountEditorWithBubble(
      'Intro paragraph\n\nVisit [docs](https://example.com) today'
    )
    activeEditor.commands.setTextSelection(2)
    const linkEl = activeEditor.view.dom.querySelector('a')!

    act(() => {
      linkEl.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, buttons: 0 }))
      vi.advanceTimersByTime(160)
    })

    const removeButton = document.querySelector<HTMLButtonElement>(
      '[data-rich-markdown-link-bubble] button[aria-label="Remove link"]'
    )!
    act(() => removeButton.click())

    expect(activeEditor.getMarkdown()).toBe('Intro paragraph\n\nVisit docs today')
  })

  it('selects the full URL text on double-click in the hover bubble and keeps it open while selected', () => {
    vi.useFakeTimers()
    const { editor: activeEditor } = mountEditorWithBubble(
      'PR: [344](https://github.com/nwparker/orca-private/pull/344)'
    )
    const linkEl = activeEditor.view.dom.querySelector('a')!

    act(() => {
      linkEl.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, buttons: 0 }))
      vi.advanceTimersByTime(160)
    })

    const urlSpan = document.querySelector<HTMLSpanElement>('[data-rich-markdown-link-url]')!
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    act(() => {
      urlSpan.dispatchEvent(mouseDown)
      urlSpan.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    })

    expect(mouseDown.defaultPrevented).toBe(false)
    expect(window.getSelection()?.toString()).toBe(
      'https://github.com/nwparker/orca-private/pull/344'
    )

    const bubbleEl = document.querySelector<HTMLElement>('[data-rich-markdown-link-bubble]')!
    act(() => {
      bubbleEl.dispatchEvent(new PointerEvent('pointerout', { bubbles: false }))
      vi.advanceTimersByTime(200)
    })
    expect(document.querySelector('[data-rich-markdown-link-bubble]')).not.toBeNull()
  })
})
