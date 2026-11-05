// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserNavigationControlRow,
  type BrowserNavigationControls
} from './browser-navigation-control-row'

function renderRow(overrides: Partial<BrowserNavigationControls> = {}): BrowserNavigationControls {
  const controls: BrowserNavigationControls = {
    canGoBack: true,
    canGoForward: true,
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    navigate: vi.fn(),
    ...overrides
  }
  render(<BrowserNavigationControlRow controls={controls} addressSlot={null} />)
  return controls
}

describe('BrowserNavigationControlRow', () => {
  afterEach(cleanup)

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
})
