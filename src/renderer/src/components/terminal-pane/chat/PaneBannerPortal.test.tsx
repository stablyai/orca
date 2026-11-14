// @vitest-environment happy-dom
// A terminal tab's chat view covers its pane, so the pane's top banners move into the chat column's
// slot while it is open: one copy, in whichever view is on.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { ChatBannerSlot } from './ChatBannerSlot'
import { PaneBannerPortal } from './PaneBannerPortal'
import { resetChatBannerSlotsForTest } from './chat-banner-slot'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

function makePane(): { pane: Pick<ManagedPane, 'container'>; container: HTMLElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  return { pane: { container }, container }
}

const slot = (): Element | null => document.querySelector('[data-chat-banner-slot]')

afterEach(() => {
  cleanup()
  resetChatBannerSlotsForTest()
  document.body.innerHTML = ''
})

describe('PaneBannerPortal', () => {
  it('shows in the pane while the pane shows its terminal', () => {
    const { pane, container } = makePane()
    render(
      <PaneBannerPortal pane={pane} paneKey={PANE_KEY} portalKey="k">
        <p>banner</p>
      </PaneBannerPortal>
    )
    expect(container.textContent).toBe('banner')
  })

  it('moves to the chat column while the chat view is open, and back when it closes', () => {
    const { pane, container } = makePane()
    const view = (chatOpen: boolean) => (
      <>
        {chatOpen ? <ChatBannerSlot paneKey={PANE_KEY} /> : null}
        <PaneBannerPortal pane={pane} paneKey={PANE_KEY} portalKey="k">
          <p>banner</p>
        </PaneBannerPortal>
      </>
    )
    const { rerender } = render(view(true))
    expect(slot()?.textContent).toBe('banner')
    expect(container.textContent).toBe('')
    expect(screen.getAllByText('banner')).toHaveLength(1)
    rerender(view(false))
    expect(container.textContent).toBe('banner')
    expect(screen.getAllByText('banner')).toHaveLength(1)
  })

  it("never shows in another pane's chat column", () => {
    const { pane, container } = makePane()
    render(
      <>
        <ChatBannerSlot paneKey="tab-1:22222222-2222-4222-8222-222222222222" />
        <PaneBannerPortal pane={pane} paneKey={PANE_KEY} portalKey="k">
          <p>banner</p>
        </PaneBannerPortal>
      </>
    )
    expect(container.textContent).toBe('banner')
    expect(slot()?.textContent).toBe('')
  })
})
