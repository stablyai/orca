import { expect, it } from 'vitest'
import { clipEmbeddedBrowser } from './embedded-browser-clip'

const bounds = { left: 100, top: 50, right: 500, bottom: 350 }

it('cuts a foreground card out of the browser surface', () => {
  expect(
    clipEmbeddedBrowser(bounds, bounds, [{ left: 200, top: 150, right: 400, bottom: 250 }])
  ).toBe("path('M0,0H400V100H0Z M0,200H400V300H0Z M0,100H100V200H0Z M300,100H400V200H300Z')")
})

it('clips outside the canvas and fully covered guests without retaining hit targets', () => {
  expect(clipEmbeddedBrowser(bounds, bounds, [bounds])).toBe('inset(100%)')
  expect(clipEmbeddedBrowser(bounds, { ...bounds, left: 150 }, [])).toBe(
    "path('M50,0H400V300H50Z')"
  )
  expect(clipEmbeddedBrowser(bounds, { ...bounds, left: 600, right: 900 }, [])).toBe('inset(100%)')
})

it('does not reopen a hole where foreground cards overlap', () => {
  expect(
    clipEmbeddedBrowser(bounds, bounds, [
      { ...bounds, right: 350 },
      { ...bounds, left: 250 }
    ])
  ).toBe('inset(100%)')
})
