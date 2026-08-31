// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRef } from 'react'

const mocks = vi.hoisted(() => ({
  addressBar: {
    current: null as { onSubmit: () => void; onNavigate: (url: string) => void } | null
  }
}))

vi.mock('./BrowserAddressBar', () => ({
  default: (props: { value: string; onSubmit: () => void; onNavigate: (url: string) => void }) => {
    mocks.addressBar.current = props
    return <input aria-label="Address" value={props.value} readOnly />
  }
}))

import BrowserAddressBar from './BrowserAddressBar'
import {
  BROWSER_CHROME_ADDRESS_SLOT_ATTRIBUTE,
  BROWSER_CHROME_ADDRESS_SLOT_HEIGHT_CLASS
} from './browser-chrome-address-slot'
import {
  BrowserNavigationControlRow,
  type BrowserNavigationControls
} from './browser-navigation-control-row'

function renderRow(overrides: Partial<BrowserNavigationControls> = {}): BrowserNavigationControls {
  const controls: BrowserNavigationControls = {
    canGoBack: true,
    canGoForward: true,
    loading: false,
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    navigate: vi.fn(),
    ...overrides
  }
  function Host(): React.JSX.Element {
    const inputRef = useRef<HTMLInputElement | null>(null)
    return (
      <BrowserNavigationControlRow
        controls={controls}
        addressSlot={
          <BrowserAddressBar
            value="https://example.com/"
            onChange={vi.fn()}
            onSubmit={vi.fn()}
            onNavigate={controls.navigate}
            inputRef={inputRef}
          />
        }
      />
    )
  }
  render(<Host />)
  return controls
}

/** The read-only counterpart the document preview passes, standing in for any non-URL identity. */
function renderWithIdentityChip(): void {
  render(
    <BrowserNavigationControlRow
      controls={{
        canGoBack: false,
        canGoForward: false,
        loading: false,
        goBack: vi.fn(),
        goForward: vi.fn(),
        reload: vi.fn(),
        navigate: vi.fn()
      }}
      addressSlot={<span>docs/report.html</span>}
    />
  )
}

describe('BrowserNavigationControlRow', () => {
  afterEach(() => cleanup())

  it('drives every history action through the controls seam', () => {
    const controls = renderRow()
    screen.getByLabelText('Back').click()
    screen.getByLabelText('Forward').click()
    screen.getByLabelText('Reload').click()
    expect(controls.goBack).toHaveBeenCalledTimes(1)
    expect(controls.goForward).toHaveBeenCalledTimes(1)
    expect(controls.reload).toHaveBeenCalledTimes(1)
  })

  it('disables history buttons from the backend-reported history depth', () => {
    renderRow({ canGoBack: false, canGoForward: false })
    expect(screen.getByLabelText<HTMLButtonElement>('Back').disabled).toBe(true)
    expect(screen.getByLabelText<HTMLButtonElement>('Forward').disabled).toBe(true)
  })

  it('routes an address-bar suggestion pick into the backend navigate', () => {
    const controls = renderRow()
    mocks.addressBar.current?.onNavigate('https://picked.example/')
    expect(controls.navigate).toHaveBeenCalledWith('https://picked.example/')
  })

  it('anchors the contextual tour on whichever backend renders the row', () => {
    renderRow()
    expect(document.querySelector('[data-contextual-tour-target="browser-toolbar"]')).not.toBeNull()
  })

  // Why: the row must not assume its middle is an address bar — a surface with no URL to type
  // still gets the same history controls in the same chrome.
  it('renders a non-address identity widget in the same slot', () => {
    renderWithIdentityChip()
    expect(screen.getByText('docs/report.html')).not.toBeNull()
    expect(screen.queryByLabelText('Address')).toBeNull()
    expect(screen.getByLabelText('Back')).not.toBeNull()
    expect(screen.getByLabelText('Reload')).not.toBeNull()
  })

  // Why the row and not each widget: a text input and a line of text come out different heights,
  // and the whole toolbar would change size when a document tab replaces a web tab.
  it('gives every identity widget the same slot height, and stretches it to fill', () => {
    renderRow()
    const addressSlot = document.querySelector(`[${BROWSER_CHROME_ADDRESS_SLOT_ATTRIBUTE}]`)
    const addressSlotClass = addressSlot?.className ?? ''
    const addressWidgetParent = screen.getByLabelText('Address').parentElement
    cleanup()

    renderWithIdentityChip()
    const chipSlot = document.querySelector(`[${BROWSER_CHROME_ADDRESS_SLOT_ATTRIBUTE}]`)

    expect(addressSlotClass).toContain(BROWSER_CHROME_ADDRESS_SLOT_HEIGHT_CLASS)
    expect(chipSlot?.className).toBe(addressSlotClass)
    expect(addressSlotClass).toContain('items-stretch')
    // Both widgets are direct children, so the slot's height reaches them instead of a wrapper.
    expect(addressWidgetParent).toBe(addressSlot)
    expect(screen.getByText('docs/report.html').parentElement).toBe(chipSlot)
  })
})
