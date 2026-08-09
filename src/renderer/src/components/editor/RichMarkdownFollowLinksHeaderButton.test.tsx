// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { RichMarkdownFollowLinksHeaderButton } from './RichMarkdownFollowLinksHeaderButton'
import { RichMarkdownFollowLinksProvider } from './rich-markdown-follow-links-state'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('RichMarkdownFollowLinksHeaderButton', () => {
  let container: HTMLDivElement
  let root: Root

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('toggles pane-scoped follow-links state', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(
        <TooltipProvider>
          <RichMarkdownFollowLinksProvider>
            <RichMarkdownFollowLinksHeaderButton />
          </RichMarkdownFollowLinksProvider>
        </TooltipProvider>
      )
    })

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Follow links on click"]'
    )
    expect(button?.getAttribute('aria-pressed')).toBe('false')

    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    act(() => {
      button?.dispatchEvent(mouseDown)
    })
    expect(mouseDown.defaultPrevented).toBe(true)

    act(() => button?.click())
    expect(button?.getAttribute('aria-pressed')).toBe('true')
  })
})
