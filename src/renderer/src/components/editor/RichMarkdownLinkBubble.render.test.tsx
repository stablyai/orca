// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { RichMarkdownLinkBubble, type LinkBubbleState } from './RichMarkdownLinkBubble'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

afterEach(cleanup)

beforeEach(() => {
  setViewportSize(1200, 800)
})

function setViewportSize(width: number, height: number): void {
  Object.assign(window, { innerWidth: width, innerHeight: height })
}

const LINK_BUBBLE: LinkBubbleState = {
  kind: 'markdown',
  href: 'https://example.com',
  left: 40,
  top: 60,
  openEnabled: true,
  copyEnabled: true
}

function renderBubble(): { onDismiss: ReturnType<typeof vi.fn> } {
  const anchorElement = document.createElement('div')
  document.body.append(anchorElement)
  const onDismiss = vi.fn()
  render(
    <TooltipProvider>
      <RichMarkdownLinkBubble
        anchorElement={anchorElement}
        linkBubble={LINK_BUBBLE}
        isEditing={false}
        onDismiss={onDismiss}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onEditStart={vi.fn()}
        onEditCancel={vi.fn()}
        onOpen={vi.fn()}
        onCopy={vi.fn()}
      />
    </TooltipProvider>
  )
  onDismiss.mockClear()
  return { onDismiss }
}

describe('RichMarkdownLinkBubble viewport dismissal', () => {
  it('stays open when a resize reports the same viewport size', () => {
    const { onDismiss } = renderBubble()

    // Why: the reveal reflow fires a real resize event without changing any dimension.
    fireEvent(window, new Event('resize'))

    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('dismisses when a resize actually changes the viewport size', () => {
    const { onDismiss } = renderBubble()

    setViewportSize(1200, 640)
    fireEvent(window, new Event('resize'))

    expect(onDismiss).toHaveBeenCalled()
  })

  it('still dismisses on a real resize that follows a no-op one', () => {
    const { onDismiss } = renderBubble()

    fireEvent(window, new Event('resize'))
    setViewportSize(900, 800)
    fireEvent(window, new Event('resize'))

    expect(onDismiss).toHaveBeenCalled()
  })
})
