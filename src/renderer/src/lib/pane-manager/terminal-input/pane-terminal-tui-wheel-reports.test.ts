// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import {
  createTerminalTuiMouseWheelDistanceState,
  resolveTerminalTuiMouseWheelReportCount
} from './pane-terminal-tui-wheel-reports'
import {
  emitCoalescedCoreWheelReports,
  type TerminalWheelTarget
} from './pane-terminal-core-wheel-encoder'

describe('pane terminal TUI wheel reports', () => {
  it('keeps fast macOS trackpad flicks linear instead of misclassifying them as discrete wheel bursts', () => {
    const state = createTerminalTuiMouseWheelDistanceState()
    const metrics = { cellHeight: 16 }

    // Initial high-velocity trackpad samples have 3x continuous ratio and non-120 legacy multiples.
    const reports = [
      resolveTerminalTuiMouseWheelReportCount(
        { deltaY: -55, wheelDeltaY: 165, deltaMode: 0, timeStamp: 10 },
        1,
        state,
        metrics
      ),
      resolveTerminalTuiMouseWheelReportCount(
        { deltaY: -45, wheelDeltaY: 135, deltaMode: 0, timeStamp: 20 },
        1,
        state,
        metrics
      ),
      resolveTerminalTuiMouseWheelReportCount(
        { deltaY: -45, wheelDeltaY: 135, deltaMode: 0, timeStamp: 30 },
        1,
        state,
        metrics
      )
    ]

    expect(reports).toEqual([3, 3, 3])
  })

  it('preserves compressed discrete wheel stepping for 120-unit notched wheel detents', () => {
    const state = createTerminalTuiMouseWheelDistanceState()
    const reports = resolveTerminalTuiMouseWheelReportCount(
      { deltaY: -120, wheelDeltaY: 120, deltaMode: 0, timeStamp: 10 },
      1,
      state,
      { cellHeight: 16 }
    )

    // 120 / 16 = 7.5 raw rows -> compressed discrete step yields 5 rows rather than linear 7.
    expect(reports).toBe(5)
  })

  it('emits a single coalesced core mouse wheel payload without calling getBoundingClientRect when cached rect exists', () => {
    const dataPayloads: { data: string; wasUserInput?: boolean }[] = []
    const binaryPayloads: string[] = []
    const getBoundingClientRect = vi.fn(() => new DOMRect(0, 0, 800, 320))
    const screenElement = document.createElement('div')
    screenElement.getBoundingClientRect = getBoundingClientRect

    let defaultEncoding = false
    const encodedEvents: { col: number; row: number; button: number; action: number }[] = []
    const terminal: TerminalWheelTarget = {
      attachCustomWheelEventHandler: () => {},
      element: screenElement,
      cols: 100,
      rows: 20,
      modes: { mouseTrackingMode: 'any' },
      dimensions: {
        css: {
          cell: { width: 8, height: 16 },
          canvas: { width: 800, height: 320 }
        }
      },
      _core: {
        screenElement,
        buffer: { cols: 100, rows: 20 },
        mouseStateService: {
          get isDefaultEncoding() {
            return defaultEncoding
          },
          restrictMouseEvent: () => true,
          encodeMouseEvent: (ev) => {
            encodedEvents.push({ col: ev.col, row: ev.row, button: ev.button, action: ev.action })
            return `\x1b[<64;${ev.col};${ev.row}M`
          }
        },
        coreService: {
          triggerDataEvent: (data, wasUserInput) => {
            dataPayloads.push({ data, wasUserInput })
          },
          triggerBinaryEvent: (data) => {
            binaryPayloads.push(data)
          }
        }
      }
    }

    const wheelEvent = new WheelEvent('wheel', { deltaY: -48 })
    Object.defineProperties(wheelEvent, {
      clientX: { value: 134 },
      clientY: { value: 84 }
    })
    const cachedRect = { left: 100, top: 50, width: 800, height: 320 }

    expect(emitCoalescedCoreWheelReports(terminal, cachedRect, wheelEvent, -1, 4)).toBe(true)
    expect(getBoundingClientRect).not.toHaveBeenCalled()
    expect(encodedEvents).toEqual([{ col: 5, row: 3, button: 4, action: 0 }])
    expect(dataPayloads).toEqual([{ data: '\x1b[<64;5;3M'.repeat(4), wasUserInput: true }])
    expect(binaryPayloads).toEqual([])

    defaultEncoding = true
    expect(emitCoalescedCoreWheelReports(terminal, cachedRect, wheelEvent, 1, 2)).toBe(true)
    expect(getBoundingClientRect).not.toHaveBeenCalled()
    expect(binaryPayloads).toEqual(['\x1b[<64;5;3M'.repeat(2)])
  })
})
