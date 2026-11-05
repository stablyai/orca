import { afterEach, describe, expect, it, vi } from 'vitest'
import { scanSynchronizedForegroundOutput } from './foreground-output-scan'
import {
  SYNCHRONIZED_OUTPUT_START_SEQUENCE as start,
  SYNCHRONIZED_OUTPUT_END_SEQUENCE as end
} from '../../../../../shared/terminal/protocol/escape/terminal-synchronized-output-scan'

afterEach(() => vi.restoreAllMocks())

describe('foreground synchronized output scan', () => {
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
})
