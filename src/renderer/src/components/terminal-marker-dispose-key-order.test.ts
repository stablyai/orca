// @vitest-environment happy-dom

import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression for #10879: scrollback trim while search decorations are live was
 * O(k²) because Marker.dispose set line=-1 before firing onDispose, so
 * SortedList.delete collapsed every eviction onto key -1.
 *
 * Assert dispose listeners still observe a non-negative line (the SortedList key).
 */
describe('xterm Marker dispose key order', () => {
  let terminal: Terminal | undefined

  beforeEach(() => {
    // happy-dom has no canvas text metrics; xterm measures glyphs on open().
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 8 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    terminal?.dispose()
    terminal = undefined
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('fires onDispose while marker.line is still the sort key', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    terminal = new Terminal({ rows: 5, cols: 40, scrollback: 10 })
    terminal.open(container)

    await new Promise<void>((resolve) => terminal!.write('hello\r\n', resolve))
    const marker = terminal.registerMarker(0)
    expect(marker).not.toBeNull()
    expect(marker!.line).toBeGreaterThanOrEqual(0)

    let lineSeenOnDispose: number | null = null
    marker!.onDispose(() => {
      lineSeenOnDispose = marker!.line
    })

    marker!.dispose()

    expect(lineSeenOnDispose).toBeGreaterThanOrEqual(0)
    expect(marker!.line).toBe(-1)
  })
})
