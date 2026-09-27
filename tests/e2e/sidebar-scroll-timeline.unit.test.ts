import { describe, expect, it, vi } from 'vitest'

vi.mock('./helpers/orca-app', async () => ({ expect: (await import('vitest')).expect }))

import {
  expectSidebarScrollProgress,
  isSidebarScrollIntermediate,
  measureSidebarScroll,
  type SidebarScrollSample
} from './sidebar-scroll-timeline'

function ramp(from: number, to: number, steps = 20): number[] {
  return Array.from({ length: steps }, (_, index) => from + ((to - from) * (index + 1)) / steps)
}

function capture(offsets: number[], destination = 1_000, interval = 16): SidebarScrollSample[] {
  return offsets.map((scrollTop, index) => {
    const top = 200 + destination - scrollTop
    return {
      time: (index + 1) * interval,
      scrollTop,
      geometry: {
        top,
        height: 100,
        viewportHeight: 743,
        contentTop: top + 6,
        contentHeight: 20,
        contentVisible: true
      }
    }
  })
}

function healthy(initial = 0, destination = 1_000): SidebarScrollSample[] {
  return capture(
    [initial, ...ramp(initial, destination), ...Array(30).fill(destination)],
    destination
  )
}

function expectAccepted(samples: SidebarScrollSample[], initial = 0) {
  const metrics = measureSidebarScroll(samples, initial)
  expectSidebarScrollProgress(metrics)
  expect(metrics.longestPause).toBeLessThan(200)
  expect(metrics.arrivalMs).toBeLessThan(1_700)
  expect(metrics.maxReverseStep).toBeLessThanOrEqual(2)
  expect(metrics.maxOvershoot).toBeLessThanOrEqual(2)
  return metrics
}

describe('independently observed sidebar landing', () => {
  it.each([
    [0, 1_000],
    [3_000, 6_000],
    [6_000, 3_000]
  ])('accepts healthy motion from %i to %i', (initial, destination) => {
    const samples = healthy(initial, destination)
    const metrics = expectAccepted(samples, initial)
    expect(metrics.finalOffset).toBe(destination)
    expect(metrics.arrivalMs).toBe(336)
    expect(metrics.confirmedAtMs).toBe(688)
    expect(metrics.initialDelayMs).toBe(32)
    expect(metrics.observedProgressBands).toBe(5)
    expect(isSidebarScrollIntermediate(samples[5], metrics)).toBe(true)
  })

  it.each([300, 600])('keeps a %ims startup delay in acceptance', (delay) => {
    const samples = capture([
      ...Array(Math.ceil(delay / 16)).fill(0),
      ...ramp(0, 1_000),
      ...Array(30).fill(1_000)
    ])
    const metrics = measureSidebarScroll(samples)
    expect(metrics.status).toBe('complete')
    expect(metrics.initialDelayMs).toBeGreaterThanOrEqual(delay)
    expect(metrics.longestPause).toBeGreaterThanOrEqual(delay)
    expect(metrics.maxFrameGap).toBe(16)
    expect(() => expectAccepted(samples)).toThrow()
  })

  it.each([300, 600])('rejects a true %ims mid-motion stall with healthy frames', (delay) => {
    const samples = capture([
      0,
      ...ramp(0, 400, 10),
      ...Array(Math.ceil(delay / 16)).fill(400),
      ...ramp(400, 1_000),
      ...Array(30).fill(1_000)
    ])
    const metrics = measureSidebarScroll(samples)
    expect(metrics.status).toBe('complete')
    expect(metrics.initialDelayMs).toBe(32)
    expect(metrics.laterPause).toBeGreaterThanOrEqual(delay)
    expect(metrics.maxInMotionFrameGap).toBe(16)
    expect(() => expectAccepted(samples)).toThrow()
  })

  it.each([300, 600])(
    'censors an unfinished %ims offscreen plateau after early request clear',
    (delay) => {
      const samples = capture([
        0,
        ...ramp(0, 400, 10),
        ...Array(Math.ceil(delay / 16)).fill(400)
      ]).map((sample) => ({ ...sample, pending: false }))
      const metrics = measureSidebarScroll(samples)
      expect(metrics.status).toBe('censored')
      expect(metrics.arrivalMs).toBeNull()
      expect(metrics.finalOffset).toBeNull()
      expect(metrics.openTailPauseMs).toBeGreaterThanOrEqual(delay)
      expect(metrics.lastObservedOffset).toBe(400)
      expect(isSidebarScrollIntermediate(samples[5], metrics)).toBe(false)
      expect(() => expectSidebarScrollProgress(metrics)).toThrow()
    }
  )

  it('does not turn an entirely stationary offscreen capture into completion', () => {
    const metrics = measureSidebarScroll(capture(Array(100).fill(0)))
    expect(metrics.status).toBe('censored')
    expect(metrics.initialDelayMs).toBeNull()
    expect(metrics.initialDelayLowerBoundMs).toBe(1_600)
    expect(metrics.longestPause).toBe(1_600)
  })

  it('rejects jump-only movement despite a complete geometry endpoint', () => {
    const metrics = measureSidebarScroll(capture([0, ...Array(30).fill(1_000)]))
    expect(metrics.status).toBe('complete')
    expect(metrics.intermediateOffsets).toBe(0)
    expect(() => expectSidebarScrollProgress(metrics)).toThrow()
  })

  it('reports the four-tiny-steps-then-jump limitation without inventing a coverage gate', () => {
    const metrics = measureSidebarScroll(capture([0, 1, 2, 3, 4, ...Array(30).fill(1_000)]))
    expect(metrics.status).toBe('complete')
    expect(metrics.intermediateOffsets).toBe(4)
    expect(metrics.observedProgressBands).toBe(1)
    expect(() => expectSidebarScrollProgress(metrics)).not.toThrow()
  })

  it('does not infer dense capture from one-Hz matching endpoints', () => {
    const metrics = measureSidebarScroll(
      capture([0, 200, 400, 600, 800, 1_000, 1_000], 1_000, 1_000)
    )
    expect(metrics.status).toBe('censored')
    expect(metrics.maxFrameGap).toBe(1_000)
    expect(() => expectSidebarScrollProgress(metrics)).toThrow()
  })

  it('rejects an in-flight 210ms gap', () => {
    const samples = healthy().map((sample, index) => ({
      ...sample,
      time: sample.time + (index >= 5 ? 194 : 0)
    }))
    const metrics = measureSidebarScroll(samples)
    expect(metrics.status).toBe('complete')
    expect(metrics.maxFrameGap).toBe(210)
    expect(() => expectSidebarScrollProgress(metrics)).toThrow()
  })

  it('excludes a gap after dense stable confirmation from motion cadence', () => {
    const samples = healthy()
    const last = samples.at(-1)!
    samples.push({ ...last, time: last.time + 210 })
    const metrics = expectAccepted(samples)
    expect(metrics.maxFrameGap).toBe(16)
    expect(metrics.arrivalMs).toBe(336)
  })

  it('does not bridge a gap to manufacture 350ms of stable observation', () => {
    const samples = capture([0, ...ramp(0, 1_000), ...Array(10).fill(1_000)])
    const last = samples.at(-1)!
    samples.push({ ...last, time: last.time + 210 })
    expect(measureSidebarScroll(samples).status).toBe('censored')
  })

  it.each([
    [0, 1_000],
    [3_000, 2_000]
  ])('detects reversal and overshoot from %i', (initial, destination) => {
    const direction = Math.sign(destination - initial)
    const samples = capture(
      [
        initial,
        ...ramp(initial, destination),
        destination + direction * 50,
        ...Array(30).fill(destination)
      ],
      destination
    )
    const metrics = measureSidebarScroll(samples, initial)
    expect(metrics.status).toBe('complete')
    expect(metrics.maxReverseStep).toBe(50)
    expect(metrics.maxOvershoot).toBe(50)
    expect(() => expectAccepted(samples, initial)).toThrow()
  })

  it('requires visible content, including the requested rename input', () => {
    const missing = healthy().map((sample) => ({ ...sample, geometry: null }))
    expect(measureSidebarScroll(missing).status).toBe('censored')
    const hidden = healthy().map((sample) => ({
      ...sample,
      geometry: sample.geometry && { ...sample.geometry, contentVisible: false }
    }))
    expect(measureSidebarScroll(hidden).status).toBe('censored')
  })

  it.each([{ height: 600 }, { contentTop: 740, contentHeight: 20 }, { contentHeight: 0 }])(
    'censors clipped or empty positive geometry: %o',
    (changed) => {
      const samples = healthy().map((sample) => ({
        ...sample,
        geometry: sample.geometry && { ...sample.geometry, ...changed }
      }))
      expect(measureSidebarScroll(samples).status).toBe('censored')
    }
  )

  it('rejects nonfinite geometry and initial offset', () => {
    const samples = healthy().map((sample) => ({
      ...sample,
      geometry: sample.geometry && { ...sample.geometry, height: Number.NaN }
    }))
    expect(measureSidebarScroll(samples).status).toBe('invalid')
    expect(measureSidebarScroll(healthy(), Number.NaN).status).toBe('invalid')
  })

  it('does not count highlight only before arrival', () => {
    const samples = healthy().map((sample) => ({ ...sample, highlighted: sample.time < 336 }))
    expect(expectAccepted(samples).highlightedAfterArrival).toBe(false)
  })

  it('accepts a later highlight without adding a confirmation-time deadline', () => {
    const samples = capture([0, ...ramp(0, 1_000), ...Array(230).fill(1_000)]).map((sample) => ({
      ...sample,
      highlighted: sample.time >= 1_000 && sample.time < 2_500
    }))
    const metrics = expectAccepted(samples)
    expect(metrics.confirmedAtMs).toBe(688)
    expect(metrics.highlightedAfterArrival).toBe(true)
    expect(samples.at(-1)?.highlighted).toBe(false)
  })

  it('invalidates an earlier endpoint after a late layout change', () => {
    const samples = healthy()
    const last = samples.at(-1)!
    samples.push({
      ...last,
      time: last.time + 16,
      geometry: last.geometry && { ...last.geometry, height: 120 }
    })
    expect(measureSidebarScroll(samples).status).toBe('censored')
    const changed = samples.at(-1)!
    samples.push(
      ...Array.from({ length: 23 }, (_, index) => ({
        ...changed,
        time: changed.time + 16 * (index + 1)
      }))
    )
    const metrics = measureSidebarScroll(samples)
    expect(metrics.status).toBe('complete')
    expect(metrics.arrivalMs).toBe(changed.time)
  })

  it('rejects cumulative drift despite tiny per-frame geometry deltas', () => {
    const samples = healthy().map((sample, index) => ({
      ...sample,
      geometry: sample.geometry && {
        ...sample.geometry,
        height: 100 + Math.max(0, index - 20) * 0.2
      }
    }))
    expect(measureSidebarScroll(samples).status).toBe('censored')
  })

  it('records a complete late landing without raising the latency gate', () => {
    const samples = capture([0, ...ramp(0, 1_000, 120), ...Array(30).fill(1_000)])
    const metrics = measureSidebarScroll(samples)
    expect(metrics.status).toBe('complete')
    expect(metrics.arrivalMs).toBeGreaterThan(1_700)
    expect(() => expectAccepted(samples)).toThrow()
  })

  it('preserves sampled highlight even after its 1500ms duration expires', () => {
    const samples = capture([0, ...ramp(0, 1_000), ...Array(130).fill(1_000)]).map((sample) => ({
      ...sample,
      highlighted: sample.time >= 350 && sample.time < 1_850
    }))
    const metrics = expectAccepted(samples)
    expect(samples.at(-1)?.highlighted).toBe(false)
    expect(metrics.highlightedAfterArrival).toBe(true)
    expect(measureSidebarScroll(healthy()).highlightedAfterArrival).toBe(false)
  })

  it('uses viewport minus inset for oversized title alignment', () => {
    const samples = healthy().map((sample) => ({
      ...sample,
      geometry: sample.geometry && { ...sample.geometry, top: 34, height: 720, contentTop: 40 }
    }))
    expect(measureSidebarScroll(samples).status).toBe('censored')
    expect(measureSidebarScroll(samples, 0, { allowOversized: true }).status).toBe('complete')
  })

  it.each(['empty', 'duplicate', 'decreasing', 'nonfinite', 'timeout'] as const)(
    'rejects invalid capture: %s',
    (kind) => {
      let samples = healthy()
      if (kind === 'empty') {
        samples = []
      }
      if (kind === 'duplicate') {
        samples[1].time = samples[0].time
      }
      if (kind === 'decreasing') {
        samples[1].time = samples[0].time - 1
      }
      if (kind === 'nonfinite') {
        samples[1].scrollTop = Number.NaN
      }
      const metrics = measureSidebarScroll(samples, 0, { captureTimedOut: kind === 'timeout' })
      expect(metrics.status).toBe('invalid')
      expect(metrics.arrivalMs).toBeNull()
      expect(() => expectSidebarScrollProgress(metrics)).toThrow()
    }
  )
})
