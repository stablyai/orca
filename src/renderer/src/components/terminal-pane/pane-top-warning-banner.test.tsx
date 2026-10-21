// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaneTopWarningBanner } from './PaneTopWarningBanner'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const BANNER_HEIGHT = 40

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

let paneElement: HTMLDivElement
let root: Root

function renderBanners(titles: string[]): void {
  act(() => {
    root.render(
      <>
        {titles.map((title) => (
          <PaneTopWarningBanner key={title} title={title} primaryAction={null} />
        ))}
      </>
    )
  })
}

function offsets(): string[] {
  return Array.from(paneElement.querySelectorAll<HTMLElement>(':scope > .pane-top-banner')).map(
    (banner) => banner.style.getPropertyValue('--orca-pane-top-banner-offset')
  )
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  // Why: happy-dom lays nothing out, so every banner reports the same fixed height.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(BANNER_HEIGHT)
  paneElement = document.createElement('div')
  document.body.appendChild(paneElement)
  root = createRoot(paneElement)
})

afterEach(() => {
  act(() => root.unmount())
  paneElement.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('PaneTopWarningBanner', () => {
  it('stacks two banners in one pane and reserves their combined height', () => {
    renderBanners(['first', 'second'])
    expect(offsets()).toEqual(['0px', `${BANNER_HEIGHT}px`])
    expect(paneElement.style.getPropertyValue('--orca-pane-top-banner-height')).toBe(
      `${BANNER_HEIGHT * 2}px`
    )

    renderBanners(['first'])
    expect(offsets()).toEqual(['0px'])
    expect(paneElement.style.getPropertyValue('--orca-pane-top-banner-height')).toBe(
      `${BANNER_HEIGHT}px`
    )
  })

  it('frees the reserved space once the last banner leaves', () => {
    renderBanners(['only'])
    renderBanners([])
    expect(paneElement.style.getPropertyValue('--orca-pane-top-banner-height')).toBe('')
  })
})
