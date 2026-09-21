// STA-5208: the duplicate-PTY reveal oracle parsed `serializeAddon.serialize()`, which
// concatenates the whole normal buffer (scrollback included) ahead of the alt frame, so a
// stale marker left behind by the pre-hide paint was read as the revealed pane's current
// frame. These pin the replacement oracle: read the frame off the active buffer's viewport.
import '../../../src/main/daemon/xterm-env-polyfill'
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import type { Page } from '@stablyai/playwright-test'
import { findMarkerFrame, readActiveScreen, readRenderedAltScreenFrame } from './alt-screen-frame'

const MARKER = 'DUPLICATE_PTY_REVEAL_TEST'
const TAB_ID = 'tab-under-test'

type Harness = { page: Page; terminal: Terminal; serialize: () => string }

// Matches the streaming TUI fixture in terminal-duplicate-pty-renderer-reveal.spec.ts.
function frameLine(frame: number): string {
  return `${MARKER} frame ${String(frame).padStart(6, '0')}`
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, () => resolve()))
}

// Runs the helper's real in-page closure against a headless terminal so the test covers
// the code the browser executes rather than a copy of it.
function createHarness(rows: number): Harness {
  const terminal = new Terminal({ cols: 80, rows, scrollback: 100, allowProposedApi: true })
  const serializeAddon = new SerializeAddon()
  terminal.loadAddon(serializeAddon)
  const pane = { terminal, serializeAddon }
  ;(globalThis as Record<string, unknown>).__paneManagers = new Map([
    [TAB_ID, { getPanes: () => [pane] }]
  ])
  const page = {
    evaluate: <Arg, Result>(fn: (arg: Arg) => Result, arg: Arg): Promise<Result> =>
      Promise.resolve(fn(arg))
  } as unknown as Page
  return { page, terminal, serialize: () => serializeAddon.serialize() }
}

// The oracle this replaces: a positional scan over every buffer serialize() emits.
function parseSerializedFrame(content: string, pick: 'first' | 'last'): number | null {
  const prefix = `${MARKER} frame `
  const start = pick === 'first' ? content.indexOf(prefix) : content.lastIndexOf(prefix)
  if (start < 0) {
    return null
  }
  const digits = content.slice(start + prefix.length).match(/^\d+/)?.[0]
  return digits ? Number(digits) : null
}

describe('readRenderedAltScreenFrame', () => {
  it('reads the live alt frame, not the stale copy left in the normal buffer', async () => {
    const harness = createHarness(8)
    await write(harness.terminal, `${frameLine(390)}\r\n`)
    await write(harness.terminal, `\x1b[?1049h\x1b[H${frameLine(400)}\x1b[J`)

    const serialized = harness.serialize()
    expect(parseSerializedFrame(serialized, 'first')).toBe(390)
    expect(parseSerializedFrame(serialized, 'last')).toBe(400)

    await expect(readActiveScreen(harness.page, TAB_ID)).resolves.toMatchObject({
      bufferType: 'alternate'
    })
    await expect(readRenderedAltScreenFrame(harness.page, TAB_ID, MARKER)).resolves.toBe(400)
  })

  it('reports no frame when the freshest marker scrolled off the visible rows', async () => {
    const harness = createHarness(8)
    await write(harness.terminal, `${frameLine(400)}\r\n`)
    for (let row = 0; row < 12; row += 1) {
      await write(harness.terminal, `filler row ${row}\r\n`)
    }

    // serialize() still contains the marker from scrollback, so it cannot see that nothing
    // correct is on screen; the viewport read can.
    expect(parseSerializedFrame(harness.serialize(), 'last')).toBe(400)
    await expect(readActiveScreen(harness.page, TAB_ID)).resolves.toMatchObject({
      bufferType: 'normal'
    })
    await expect(readRenderedAltScreenFrame(harness.page, TAB_ID, MARKER)).resolves.toBeNull()
  })

  // expect.poll aborts on a generator throw, so a pane mid-remount has to read as
  // "not converged yet" rather than ending the poll.
  it('returns null when the tab has no pane', async () => {
    const harness = createHarness(8)
    await expect(readActiveScreen(harness.page, 'tab-without-pane')).resolves.toBeNull()
    await expect(
      readRenderedAltScreenFrame(harness.page, 'tab-without-pane', MARKER)
    ).resolves.toBeNull()
  })
})

describe('findMarkerFrame', () => {
  it('reads frame numbers of any width', () => {
    expect(findMarkerFrame(`${MARKER} frame 000400`, MARKER)).toBe(400)
    expect(findMarkerFrame(`| ${MARKER} frame 024 |`, MARKER)).toBe(24)
  })

  it('takes the highest frame when several are on screen', () => {
    expect(findMarkerFrame([frameLine(400), frameLine(390)].join('\n'), MARKER)).toBe(400)
  })

  it('treats the marker as a literal', () => {
    expect(findMarkerFrame('A[B frame 7', 'A[B')).toBe(7)
    expect(findMarkerFrame('AxB frame 7', 'A[B')).toBeNull()
  })
})
