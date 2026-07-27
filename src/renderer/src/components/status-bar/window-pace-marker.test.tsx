import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { RateLimitWindow } from '../../../../shared/rate-limit-types'
import { WindowPaceMarker } from './window-pace-marker'

const FIVE_HOURS_MS = 300 * 60_000
const NOW = 1_000_000

function sessionWindow(overrides: Partial<RateLimitWindow> = {}): RateLimitWindow {
  return {
    usedPercent: 10,
    windowMinutes: 300,
    resetsAt: NOW + FIVE_HOURS_MS / 2,
    resetDescription: null,
    ...overrides
  }
}

describe('WindowPaceMarker', () => {
  it('renders a green tick at the elapsed-time position when on pace', () => {
    const markup = renderToStaticMarkup(
      <WindowPaceMarker w={sessionWindow()} now={NOW} display="used" />
    )
    expect(markup).toContain('left:50%')
    expect(markup).toContain('bg-green-500')
    expect(markup).toContain('data-pace="on-track"')
  })

  it('turns red when usage runs ahead of elapsed time', () => {
    const markup = renderToStaticMarkup(
      <WindowPaceMarker w={sessionWindow({ usedPercent: 80 })} now={NOW} display="used" />
    )
    expect(markup).toContain('bg-red-500')
    expect(markup).toContain('data-pace="over"')
  })

  it('mirrors the tick to the time-left position in remaining display', () => {
    const w = sessionWindow({ resetsAt: NOW + FIVE_HOURS_MS / 4 })
    const markup = renderToStaticMarkup(<WindowPaceMarker w={w} now={NOW} display="remaining" />)
    expect(markup).toContain('left:25%')
  })

  it('renders nothing without a usable reset timestamp', () => {
    const markup = renderToStaticMarkup(
      <WindowPaceMarker w={sessionWindow({ resetsAt: null })} now={NOW} display="used" />
    )
    expect(markup).toBe('')
  })
})
