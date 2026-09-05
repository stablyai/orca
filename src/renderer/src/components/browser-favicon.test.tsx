// @vitest-environment happy-dom
import { createElement } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { BrowserFavicon } from './browser-favicon'

afterEach(cleanup)

const faviconUrl = 'https://example.test/favicon.ico'
const icon = (loading = false, url: string | null = faviconUrl) =>
  createElement(BrowserFavicon, { faviconUrl: url, loading })

it('retries a failed icon after a same-origin reload completes', () => {
  const view = render(icon())
  fireEvent.error(view.container.querySelector('img')!)
  expect(view.container.querySelector('img')).toBeNull()
  view.rerender(icon(true))
  expect(view.container.querySelector('img')).toBeNull()
  view.rerender(icon(false))
  expect(view.container.querySelector('img')?.getAttribute('src')).toBe(faviconUrl)

  fireEvent.error(view.container.querySelector('img')!)
  view.rerender(icon(false))
  expect(view.container.querySelector('img')).toBeNull()
  view.rerender(icon(true))
  view.rerender(icon(false))
  expect(view.container.querySelector('img')).not.toBeNull()
})

it('keeps a working image mounted throughout a reload', () => {
  const view = render(icon())
  const image = view.container.querySelector('img')
  view.rerender(icon(true))
  expect(view.container.querySelector('img')).toBe(image)
  view.rerender(icon(false))
  expect(view.container.querySelector('img')).toBe(image)
})

it('retries an image that failed during initial loading when loading finishes', () => {
  const view = render(icon(true))
  fireEvent.error(view.container.querySelector('img')!)
  view.rerender(icon(false))
  expect(view.container.querySelector('img')).not.toBeNull()
})

it('still resets failures when the favicon URL changes or clears', () => {
  const view = render(icon())
  fireEvent.error(view.container.querySelector('img')!)
  view.rerender(icon(false, null))
  view.rerender(icon())
  expect(view.container.querySelector('img')).not.toBeNull()
  fireEvent.error(view.container.querySelector('img')!)
  view.rerender(icon(false, 'https://other.test/favicon.ico'))
  expect(view.container.querySelector('img')?.getAttribute('src')).toBe(
    'https://other.test/favicon.ico'
  )
})
