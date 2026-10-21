// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { BrowserPageZoomIndicator } from './browser-page-zoom-indicator'

afterEach(cleanup)

it('preserves zoom feedback visibility and accessible status as it updates', () => {
  const view = render(
    <BrowserPageZoomIndicator
      state={{ ariaHidden: false, opacityClassName: 'opacity-100' }}
      percent={125}
    />
  )
  const indicator = screen.getByRole('status')
  expect(indicator.textContent).toBe('125%')
  expect(indicator.getAttribute('aria-live')).toBe('polite')
  expect(indicator.getAttribute('aria-hidden')).toBe('false')
  expect(indicator.classList.contains('opacity-100')).toBe(true)
  expect(indicator.classList.contains('pointer-events-none')).toBe(true)

  view.rerender(
    <BrowserPageZoomIndicator
      state={{ ariaHidden: true, opacityClassName: 'opacity-0' }}
      percent={100}
    />
  )
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getByRole('status', { hidden: true })).toBe(indicator)
  expect(indicator.textContent).toBe('100%')
  expect(indicator.getAttribute('aria-hidden')).toBe('true')
  expect(indicator.classList.contains('opacity-0')).toBe(true)
  expect(indicator.classList.contains('opacity-100')).toBe(false)
})
