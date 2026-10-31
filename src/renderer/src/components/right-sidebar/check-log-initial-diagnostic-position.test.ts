// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR as separator } from '../../../../shared/check-job-log-tail-slice'
import {
  findInitialCheckLogDiagnostic,
  measureInitialCheckLogScrollTop
} from './check-log-initial-diagnostic-position'
import {
  capturedCheckLogExcerpt,
  capturedCheckLogFailure,
  capturedCheckLogFrame
} from './check-job-log-captured-fixture'

describe('captured check log failure', () => {
  it('retains the literal diagnostic and complete frame in a bounded new-host excerpt', () => {
    expect(new TextEncoder().encode(capturedCheckLogExcerpt).length).toBeLessThanOrEqual(16 * 1024)
    expect(capturedCheckLogExcerpt).toContain(capturedCheckLogFailure.expectedDiagnostic)
    expect(capturedCheckLogExcerpt).toContain(capturedCheckLogFrame)
    expect(capturedCheckLogExcerpt).toContain(capturedCheckLogFailure.benignMarker)
    expect(capturedCheckLogExcerpt).toContain(capturedCheckLogFailure.genericExitMarker)
  })

  it('opens at the actual failure and complete nearby frame instead of the benign logger or exit', () => {
    const anchor = findInitialCheckLogDiagnostic(capturedCheckLogExcerpt)
    expect(anchor).not.toBeNull()
    if (!anchor) {
      throw new Error('Missing captured failure anchor')
    }
    const selected = capturedCheckLogExcerpt.slice(anchor.start, anchor.end)
    expect(selected).toBe(capturedCheckLogFailure.expectedDiagnostic)
    expect(selected).not.toContain(capturedCheckLogFailure.benignMarker)
    expect(selected).not.toContain(capturedCheckLogFailure.genericExitMarker)
    expect(capturedCheckLogExcerpt.slice(anchor.nearbyStackStart, anchor.nearbyStackEnd)).toBe(
      capturedCheckLogFrame
    )
  })
})

describe('synthetic diagnostic excerpts', () => {
  it.each([
    ['stderr | test output\nError: first failure\nError: second failure', 'Error: first failure'],
    [
      `Error: earlier\n${separator}\nTypeError: recent\nProcess completed with exit code 1`,
      'TypeError: recent'
    ],
    [`Error: earlier\n${separator}\n##[error]Process completed with exit code 1`, 'Error: earlier'],
    [
      '::error::command failed with exit code 1\nerror TS2322: value is not assignable',
      'error TS2322: value is not assignable'
    ],
    ['ERROR: Job failed: exit code 1', null],
    ['##[error]Error: Process exited with code 1', null],
    ['::error::\nFAILED\n2 tests failed\n at file.ts:1:2', null],
    ['a benign error in a description\nENOENT: open /missing', 'ENOENT: open /missing'],
    [
      '😀 prefix Error: café failed with exit code 1 because config is invalid',
      'Error: café failed with exit code 1 because config is invalid'
    ],
    ['::error file=main.ts::invalid declaration', '::error file=main.ts::invalid declaration'],
    ['plain text without a marker', null]
  ])('selects a substantive recent target in %j', (text, expected) => {
    const anchor = findInitialCheckLogDiagnostic(text)
    expect(anchor ? text.slice(anchor.start, anchor.end) : null).toBe(expected)
  })

  it.each(['##[error]', '::error::'])('excludes whole headers and totals behind %s', (prefix) => {
    for (const heading of [
      'FAILED',
      '2 tests failed',
      'stderr',
      'test stderr',
      'stderr | suite > case'
    ]) {
      const generic = `${prefix}${heading}`
      const diagnostic = 'Error: substantive diagnostic'
      const stack = ' at actual.ts:1:2'
      const text = `${generic}\n${diagnostic}\n${stack}`
      const anchor = findInitialCheckLogDiagnostic(text)
      expect(anchor && text.slice(anchor.start, anchor.end)).toBe(diagnostic)
      expect(anchor && text.slice(anchor.nearbyStackStart, anchor.nearbyStackEnd)).toBe(stack)
      expect(findInitialCheckLogDiagnostic(`${generic}\n${stack}`)).toBeNull()

      const fallback = `${diagnostic}\n${stack}\n${separator}\n${generic}`
      const earlier = findInitialCheckLogDiagnostic(fallback)
      expect(earlier && fallback.slice(earlier.start, earlier.end)).toBe(diagnostic)
      expect(earlier && fallback.slice(earlier.nearbyStackStart, earlier.nearbyStackEnd)).toBe(
        stack
      )
    }
  })

  it.each(['##[error]', '::error::'])('keeps substantive diagnostics behind %s', (prefix) => {
    for (const body of [
      '2 tests failed because configuration is missing',
      'stderr: missing module while running 2 tests that failed',
      'stderr | suite > case TypeError: expected a function',
      'Error: 2 tests failed after the worker exited with exit code 1'
    ]) {
      const diagnostic = `${prefix}${body}`
      const stack = ' at actual.ts:1:2'
      const text = `${diagnostic}\n${stack}`
      const anchor = findInitialCheckLogDiagnostic(text)
      expect(anchor && text.slice(anchor.start, anchor.end)).toBe(diagnostic)
      expect(anchor && text.slice(anchor.nearbyStackStart, anchor.nearbyStackEnd)).toBe(stack)
    }
  })

  it('keeps a named diagnostic printed in stderr eligible', () => {
    const text = 'stderr | suite > case TypeError: expected a function\n at actual.ts:1:2'
    const anchor = findInitialCheckLogDiagnostic(text)
    expect(anchor && text.slice(anchor.start, anchor.end)).toBe('TypeError: expected a function')
  })

  it.each([
    ['[worker] handled rejection Error: expected', 'Error: failed to open database'],
    ['2026-01-02T03:04:05Z [queue] probe Error: unavailable', 'panic: corrupted database'],
    ['logger caught TypeError: invalid value', 'error TS2322: incompatible return type'],
    ['stderr | case [cache] miss Error: unavailable', '##[error]unable to publish artifact']
  ])('prefers a diagnostic-shaped line over unframed inline output %j', (logger, diagnostic) => {
    const text = `${logger}\n${diagnostic}\n at database.ts:4:5`
    const anchor = findInitialCheckLogDiagnostic(text)
    expect(anchor && text.slice(anchor.start, anchor.end)).toBe(diagnostic)
  })

  it.each(['', '2026-01-02T03:04:05.1234567Z ', '2026-01-02T03:04:05+02:00 '])(
    'keeps the first standalone stderr diagnostic after timestamp %j',
    (prefix) => {
      const text = `stderr | failed case\n${prefix}TypeError: invalid argument\nError: later failure`
      const anchor = findInitialCheckLogDiagnostic(text)
      expect(anchor && text.slice(anchor.start, anchor.end)).toBe('TypeError: invalid argument')
    }
  )

  it('keeps an inline diagnostic with stack context ahead of a later standalone error', () => {
    const text = '[worker] failed TypeError: invalid argument\n at worker.ts:3:4\nError: later'
    const anchor = findInitialCheckLogDiagnostic(text)
    expect(anchor && text.slice(anchor.start, anchor.end)).toBe('TypeError: invalid argument')
    expect(anchor && text.slice(anchor.nearbyStackStart, anchor.nearbyStackEnd)).toBe(
      ' at worker.ts:3:4'
    )
  })

  it.each([
    'Error: failed to open database at database.ts:4:5',
    '::error file=database.ts::invalid declaration at database.ts:4:5'
  ])('does not borrow a later diagnostic as a frame: %s', (diagnostic) => {
    const frame = ' at real.ts:8:9'
    for (const context of ['', 'intervening context\n']) {
      for (const timestamp of ['', '2026-01-02T03:04:05.123Z ']) {
        const segment = `[worker] caught Error: expected\n${context}${timestamp}${diagnostic}\n${frame}`
        for (const text of [
          segment,
          `Error: earlier failure\n${separator}\n${segment}`,
          `${segment}\n${separator}\nnormal recent output`
        ]) {
          const anchor = findInitialCheckLogDiagnostic(text)
          expect(anchor && text.slice(anchor.start, anchor.end)).toBe(diagnostic)
          expect(anchor && text.slice(anchor.nearbyStackStart, anchor.nearbyStackEnd)).toBe(frame)
        }
      }
    }
  })

  it('does not borrow a diagnostic or its frame from across the omission boundary', () => {
    const text = `[worker] caught Error: expected\n${separator}\nError: failed to open database at database.ts:4:5\n at real.ts:8:9`
    const anchor = findInitialCheckLogDiagnostic(text)
    expect(anchor && text.slice(anchor.start, anchor.end)).toBe(
      'Error: failed to open database at database.ts:4:5'
    )
    expect(anchor && text.slice(anchor.nearbyStackStart, anchor.nearbyStackEnd)).toBe(
      ' at real.ts:8:9'
    )
    const fallback = findInitialCheckLogDiagnostic(
      `[worker] caught Error: expected\n${separator}\n at real.ts:8:9`
    )
    expect(fallback?.nearbyStackStart).toBeUndefined()
  })

  it('retains unframed inline diagnostics as the recent-segment fallback', () => {
    const text = `Error: earlier failure\n${separator}\n[worker] failed EACCES: open database\n##[error]Process completed with exit code 1`
    const anchor = findInitialCheckLogDiagnostic(text)
    expect(anchor && text.slice(anchor.start, anchor.end)).toBe('EACCES: open database')
  })

  it('searches at most twelve retained lines without crossing the omission boundary', () => {
    const text = `TypeError: diagnostic\n${'context\n'.repeat(10)} at view.tsx:18:8\n${separator}\nnormal output`
    const anchor = findInitialCheckLogDiagnostic(text)
    expect(anchor && text.slice(anchor.nearbyStackStart, anchor.nearbyStackEnd)).toBe(
      ' at view.tsx:18:8'
    )
    expect(
      findInitialCheckLogDiagnostic(`Error: diagnostic\n${separator}\n at file.ts:1:2`)
        ?.nearbyStackStart
    ).toBeUndefined()
    expect(
      findInitialCheckLogDiagnostic(`Error: diagnostic\n${'context\n'.repeat(12)} at file.ts:1:2`)
        ?.nearbyStackStart
    ).toBeUndefined()
  })

  it('uses rendered fragment coordinates and keeps a wrapped nearby frame visible', () => {
    const pre = document.createElement('pre')
    pre.textContent = 'long wrapped prefix\nError: diagnostic\n at file.ts:1:2'
    pre.style.cssText = 'padding: 12px; line-height: 16px'
    document.body.append(pre)
    Object.defineProperties(pre, {
      clientWidth: { value: 240 },
      clientHeight: { value: 220 },
      scrollHeight: { value: 2000 },
      clientTop: { value: 1 }
    })
    vi.spyOn(pre, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 240, 220))
    const original = document.createRange.bind(document)
    const rects = [new DOMRect(12, 800, 180, 16), new DOMRect(12, 960, 180, 32)]
    const create = vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = original()
      const rect = rects.shift()
      Object.assign(range, { getClientRects: () => (rect ? [rect] : []) })
      return range
    })
    const anchor = findInitialCheckLogDiagnostic(pre.textContent)
    expect(anchor).not.toBeNull()
    if (!anchor) {
      throw new Error('Missing synthetic anchor')
    }
    expect(measureInitialCheckLogScrollTop(pre, anchor)).toBe(683)
    expect(create).toHaveBeenCalledTimes(2)
    pre.remove()
    vi.restoreAllMocks()
  })
})
