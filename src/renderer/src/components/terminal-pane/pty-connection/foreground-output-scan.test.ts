import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  scanSynchronizedForegroundOutput,
  SYNCHRONIZED_OUTPUT_START_SEQUENCE as start,
  SYNCHRONIZED_OUTPUT_END_SEQUENCE as end
} from './foreground-output-scan'

afterEach(() => vi.restoreAllMocks())

describe('foreground synchronized output scan', () => {
  it.each([start, end])('bounds searched characters for a flood of %j markers', (marker) => {
    const data = marker.repeat(8192)
    const originalIndexOf = String.prototype.indexOf
    let searchedCharacters = 0
    const spy = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (
      this: string,
      search: string,
      position = 0
    ): number {
      const result = originalIndexOf.call(this, search, position)
      if (this === data && (search === start || search === end)) {
        searchedCharacters += (result < 0 ? data.length : result + search.length) - position
      }
      return result
    })
    const result = scanSynchronizedForegroundOutput(data, '', false)
    spy.mockRestore()
    console.info(JSON.stringify({ markers: 8192, chars: data.length, searchedCharacters }))
    expect(result).toEqual({
      started: marker === start,
      ended: marker === end,
      active: marker === start,
      markerTail: data.slice(-7)
    })
    expect(searchedCharacters).toBeLessThanOrEqual(data.length * 2)
  })

  it('preserves the last marker and records both transitions in the current chunk', () => {
    expect(scanSynchronizedForegroundOutput(`${end}paint${start}`, '', true)).toEqual({
      started: true,
      ended: true,
      active: true,
      markerTail: start.slice(1)
    })
    expect(scanSynchronizedForegroundOutput(`${start}paint${end}`, '', false)).toEqual({
      started: true,
      ended: true,
      active: false,
      markerTail: end.slice(1)
    })
  })

  it.each([start, end])('recognizes %j at every socket split', (marker) => {
    for (let split = 1; split < marker.length; split++) {
      const first = scanSynchronizedForegroundOutput(marker.slice(0, split), '', marker === end)
      const second = scanSynchronizedForegroundOutput(
        marker.slice(split),
        first.markerTail,
        first.active
      )
      expect(second).toEqual({
        started: marker === start,
        ended: marker === end,
        active: marker === start,
        markerTail: marker.slice(1)
      })
    }
  })

  it('leaves the latch unchanged for empty output and malformed lookalikes', () => {
    for (const data of ['', 'ordinary output', '\x1b[?2026x'.repeat(2048)]) {
      expect(scanSynchronizedForegroundOutput(data, '', true)).toEqual({
        started: false,
        ended: false,
        active: true,
        markerTail: data.slice(-7)
      })
    }
  })
})
