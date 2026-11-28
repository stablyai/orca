// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserNavigationControlRow,
  type BrowserNavigationControls
} from './browser-navigation-control-row'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderRow(overrides: Partial<BrowserNavigationControls>): BrowserNavigationControls {
  const controls: BrowserNavigationControls = {
    canGoBack: true,
    canGoForward: true,
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    navigate: vi.fn(),
    ...overrides
  }
  act(() => {
    root.render(<BrowserNavigationControlRow controls={controls} addressSlot={<input />} />)
  })
  return controls
}

function releaseOverAddressBar(button: number): MouseEvent {
  const event = new MouseEvent('mouseup', { button, bubbles: true, cancelable: true })
  act(() => {
    container.querySelector('input')!.dispatchEvent(event)
  })
  return event
}

describe('mouse side buttons over the browser toolbar', () => {
  it('step the page history instead of the workspace history', () => {
    const controls = renderRow({})
    expect(releaseOverAddressBar(3).defaultPrevented).toBe(true)
    expect(controls.goBack).toHaveBeenCalledTimes(1)
    expect(releaseOverAddressBar(4).defaultPrevented).toBe(true)
    expect(controls.goForward).toHaveBeenCalledTimes(1)
  })

  it('claim the press without navigating when the page has no history that way', () => {
    const controls = renderRow({ canGoBack: false, canGoForward: false })
    expect(releaseOverAddressBar(3).defaultPrevented).toBe(true)
    expect(releaseOverAddressBar(4).defaultPrevented).toBe(true)
    expect(controls.goBack).not.toHaveBeenCalled()
    expect(controls.goForward).not.toHaveBeenCalled()
  })

  it('leave other buttons alone', () => {
    const controls = renderRow({})
    expect(releaseOverAddressBar(0).defaultPrevented).toBe(false)
    expect(controls.goBack).not.toHaveBeenCalled()
  })
})
