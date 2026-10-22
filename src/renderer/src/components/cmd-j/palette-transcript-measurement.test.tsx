// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PaletteTranscriptMatch } from '../worktree-jump-palette-transcript-matches'
import { classifyPaletteTranscriptProof } from './palette-transcript-proof'
import {
  PALETTE_TRANSCRIPT_MEASUREMENT_BATCH,
  PaletteTranscriptMeasurement
} from './palette-transcript-measurement'

const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts')

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  if (originalFonts) {
    Object.defineProperty(document, 'fonts', originalFonts)
  } else {
    Reflect.deleteProperty(document, 'fonts')
  }
})

it('reuses fit measurements across pane refreshes and resets them for a new search generation', () => {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { status: 'loaded', addEventListener: vi.fn(), removeEventListener: vi.fn() }
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(500)
  const measure = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(100)
  const candidate: PaletteTranscriptMatch = {
    worktreeId: 'workspace',
    tabId: 'terminal',
    ordinal: 0,
    snippet: null,
    complete: false,
    windows: classifyPaletteTranscriptProof('a refresh here', 'refresh')
  }
  const onFits = vi.fn()
  const { rerender } = render(
    <PaletteTranscriptMeasurement generationKey="first" candidates={[candidate]} onFits={onFits} />
  )
  expect(onFits.mock.lastCall?.[0].get(0)?.text).toBe('a refresh here')
  const initialMeasurements = measure.mock.calls.length
  expect(initialMeasurements).toBeGreaterThan(0)

  for (let update = 0; update < 3; update++) {
    rerender(
      <PaletteTranscriptMeasurement
        generationKey="first"
        candidates={[{ ...candidate }]}
        onFits={onFits}
      />
    )
  }
  expect(measure).toHaveBeenCalledTimes(initialMeasurements)

  rerender(
    <PaletteTranscriptMeasurement generationKey="second" candidates={[candidate]} onFits={onFits} />
  )
  expect(measure).toHaveBeenCalledTimes(initialMeasurements * 2)
})

it('remeasures after coalesced font events even when CSS font declarations are unchanged', () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
  const fonts = new EventTarget()
  Object.defineProperty(fonts, 'status', { value: 'loaded' })
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(500)
  const measure = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(100)
  const candidates: PaletteTranscriptMatch[] = [
    {
      worktreeId: 'workspace',
      tabId: 'terminal',
      ordinal: 0,
      snippet: null,
      complete: false,
      windows: classifyPaletteTranscriptProof('a refresh here', 'refresh')
    }
  ]
  const onFits = vi.fn()
  render(
    <PaletteTranscriptMeasurement generationKey="query" candidates={candidates} onFits={onFits} />
  )
  const displayKey = onFits.mock.lastCall?.[1]
  expect(onFits.mock.lastCall?.[0].has(0)).toBe(true)
  const initialMeasurements = measure.mock.calls.length
  measure.mockReturnValue(600)
  act(() => {
    fonts.dispatchEvent(new Event('loading'))
    fonts.dispatchEvent(new Event('loadingdone'))
    vi.advanceTimersByTime(50)
  })
  expect(onFits.mock.lastCall?.[1]).toBe(displayKey)
  expect(onFits.mock.lastCall?.[0].has(0)).toBe(false)
  expect(measure.mock.calls.length).toBeGreaterThan(initialMeasurements)
})

it('stages unique excerpts into bounded DOM batches and stops after fitting the requested destinations', () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { status: 'loaded', addEventListener: vi.fn(), removeEventListener: vi.fn() }
  })
  const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(500)
  const measure = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(600)
  const candidates: PaletteTranscriptMatch[] = Array.from({ length: 1000 }, (_, ordinal) => ({
    worktreeId: 'workspace',
    tabId: `tab-${ordinal % 3}`,
    ordinal,
    snippet: null,
    complete: false,
    windows: [
      {
        text: `unique refresh ${ordinal}`,
        ranges: [{ start: 7, end: 14 }],
        sourceStart: 0,
        sourceRanges: [{ start: 7, end: 14 }]
      }
    ]
  }))
  const onFits = vi.fn()
  const { container, rerender } = render(
    <PaletteTranscriptMeasurement
      generationKey="query"
      candidates={candidates}
      destinationDemand={3}
      onFits={onFits}
    />
  )
  expect(
    container.querySelectorAll('[data-slot="palette-transcript-measurement-text"]').length
  ).toBeLessThanOrEqual(PALETTE_TRANSCRIPT_MEASUREMENT_BATCH + 1)
  expect(onFits.mock.lastCall?.[2]).toBe(false)
  measure.mockReturnValue(100)
  act(() => vi.advanceTimersByTime(20))
  expect(onFits.mock.lastCall?.[2]).toBe(true)
  const fits = onFits.mock.lastCall?.[0]
  expect([...fits.keys()]).toEqual([128, 129, 130])
  const measuredCount = measure.mock.calls.length
  rerender(
    <PaletteTranscriptMeasurement
      generationKey="query"
      candidates={[...candidates]}
      destinationDemand={3}
      onFits={onFits}
    />
  )
  expect(measure.mock.calls.length).toBe(measuredCount)
  expect(onFits.mock.lastCall?.[2]).toBe(true)
  expect(
    container.querySelectorAll('[data-slot="palette-transcript-measurement-text"]').length
  ).toBe(1)

  width.mockReturnValue(700)
  act(() => {
    window.dispatchEvent(new Event('resize'))
    vi.advanceTimersByTime(100)
  })
  expect(onFits.mock.lastCall?.[2]).toBe(false)
  act(() => vi.advanceTimersByTime(20))
  expect(Array.from(onFits.mock.lastCall?.[0].keys() ?? [])).toEqual([0, 1, 2])
  expect(onFits.mock.lastCall?.[2]).toBe(true)
})

it('measures same-id destinations independently across execution hosts', () => {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { status: 'loaded', addEventListener: vi.fn(), removeEventListener: vi.fn() }
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(500)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(100)
  const candidates: PaletteTranscriptMatch[] = [
    {
      worktreeId: 'same-workspace',
      tabId: 'same-chat',
      ordinal: 0,
      snippet: null,
      complete: false,
      windows: classifyPaletteTranscriptProof('local refresh here', 'refresh')
    },
    {
      executionHostId: 'runtime:remote',
      worktreeId: 'same-workspace',
      tabId: 'same-chat',
      ordinal: 1,
      snippet: null,
      complete: false,
      windows: classifyPaletteTranscriptProof('remote refresh here', 'refresh')
    }
  ]
  const onFits = vi.fn()
  render(
    <PaletteTranscriptMeasurement
      generationKey="host-qualified"
      candidates={candidates}
      destinationDemand={2}
      onFits={onFits}
    />
  )
  const fits = onFits.mock.lastCall?.[0]
  expect(fits?.get(0)?.text).toBe('local refresh here')
  expect(fits?.get(1)?.text).toBe('remote refresh here')
  expect(onFits.mock.lastCall?.[2]).toBe(true)
})
