import { Terminal as HeadlessTerminal } from '@xterm/headless'
import type { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginTerminalScrollIntentBufferRebuild,
  endTerminalScrollIntentBufferRebuild
} from '@/lib/pane-manager/terminal-scroll/terminal-scroll-intent-rebuild'
import { getTerminalScrollIntentKind } from '@/lib/pane-manager/terminal-scroll/terminal-scroll-intent'
import { keepWakeScrollPlace } from './wake-scroll-place'

afterEach(() => vi.unstubAllGlobals())

async function terminalWith(
  lines: number
): Promise<{ headless: HeadlessTerminal; terminal: Terminal }> {
  const headless = new HeadlessTerminal({
    cols: 20,
    rows: 5,
    scrollback: 500,
    allowProposedApi: true
  })
  await new Promise<void>((resolve) =>
    headless.write(Array.from({ length: lines }, (_, i) => `line-${i}`).join('\r\n'), resolve)
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: headless xterm has the buffer and scroll API this helper uses; the DOM-only members are never read.
  return { headless, terminal: headless as unknown as Terminal }
}

describe('keepWakeScrollPlace (WAKE-SCROLLBACK-SCROLL)', () => {
  it("waits for the replay's own rebuild, then puts the person back and pins it; once more after a fit moves it", async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      frames.push(callback)
    )
    const { headless, terminal } = await terminalWith(100)
    try {
      // The replay holds its rebuild; its completion would restore the intent captured before.
      beginTerminalScrollIntentBufferRebuild(terminal)
      keepWakeScrollPlace(terminal)(40)
      expect(headless.buffer.active.viewportY).toBe(headless.buffer.active.baseY)
      endTerminalScrollIntentBufferRebuild(terminal)
      expect(headless.buffer.active.viewportY).toBe(40)
      expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')
      // The pane's own fit keeps the pin by bottom distance and moves the line; corrected once.
      headless.scrollToLine(30)
      frames.splice(0).forEach((frame) => frame(0))
      frames.splice(0).forEach((frame) => frame(0))
      expect(headless.buffer.active.viewportY).toBe(40)
    } finally {
      headless.dispose()
    }
  })

  it('leaves a person who went back to the bottom alone', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      frames.push(callback)
    )
    const { headless, terminal } = await terminalWith(100)
    try {
      keepWakeScrollPlace(terminal)(40)
      expect(headless.buffer.active.viewportY).toBe(40)
      headless.scrollToBottom()
      frames.splice(0).forEach((frame) => frame(0))
      frames.splice(0).forEach((frame) => frame(0))
      expect(headless.buffer.active.viewportY).toBe(headless.buffer.active.baseY)
    } finally {
      headless.dispose()
    }
  })
})
