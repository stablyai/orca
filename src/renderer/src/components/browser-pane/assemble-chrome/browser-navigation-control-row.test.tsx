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
        addressBarValue="https://example.com/"
        onAddressBarChange={vi.fn()}
        onSubmitAddressBar={vi.fn()}
        addressBarInputRef={inputRef}
      />
    )
  }
  render(<Host />)
  return controls
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
})
