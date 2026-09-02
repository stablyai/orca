// @vitest-environment happy-dom

import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import type { LinkBubbleState } from './RichMarkdownLinkBubble'
import { createRichMarkdownHtmlSuperscriptLinkContext } from './rich-markdown-html-superscript-link-context'

const activateMarkdownLinkMock = vi.hoisted(() => vi.fn())

vi.mock('@/store', () => ({
  useAppStore: (
    selector: (state: { activateMarkdownLink: typeof activateMarkdownLinkMock }) => unknown
  ) => selector({ activateMarkdownLink: activateMarkdownLinkMock })
}))

import { useLinkBubble } from './useLinkBubble'

describe('useLinkBubble owner hydration', () => {
  let container: HTMLDivElement
  let root: Root

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    activateMarkdownLinkMock.mockReset()
  })

  it.each<HttpLinkSourceOwner>([{ kind: 'local' }, { kind: 'ssh', connectionId: 'ssh-1' }])(
    'refreshes an open Markdown bubble when ownership becomes $kind',
    (sourceOwner) => {
      const context = createRichMarkdownHtmlSuperscriptLinkContext({
        sourceFilePath: '/repo/README.md',
        worktreeId: 'worktree-1',
        worktreeRoot: '/repo',
        sourceOwner: { kind: 'unknown' }
      })

      function Harness(): React.JSX.Element {
        const rootRef = useRef<HTMLElement>(null)
        const [bubble, setBubble] = useState<LinkBubbleState | null>({
          kind: 'markdown',
          href: 'https://example.com',
          openEnabled: false,
          copyEnabled: true,
          left: 0,
          top: 0
        })
        const { handleLinkOpen } = useLinkBubble(null, rootRef, bubble, setBubble, () => {}, {
          sourceFilePath: '/repo/README.md',
          worktreeId: 'worktree-1',
          worktreeRoot: '/repo',
          htmlSuperscriptLinkContext: context
        })
        return (
          <button data-enabled={String(bubble?.openEnabled)} onClick={handleLinkOpen}>
            {bubble?.href}
          </button>
        )
      }

      container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
      act(() => root.render(<Harness />))
      const button = container.querySelector('button')
      if (!button) {
        throw new Error('Expected link action')
      }
      expect(button.dataset.enabled).toBe('false')
      act(() => button.click())
      expect(activateMarkdownLinkMock).not.toHaveBeenCalled()

      act(() => {
        context.update({
          sourceFilePath: '/repo/README.md',
          worktreeId: 'worktree-1',
          worktreeRoot: '/repo',
          sourceOwner
        })
      })
      expect(button.dataset.enabled).toBe('true')
      expect(button.textContent).toBe('https://example.com')

      act(() => button.click())
      expect(activateMarkdownLinkMock).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({ sourceOwner })
      )
    }
  )
})
