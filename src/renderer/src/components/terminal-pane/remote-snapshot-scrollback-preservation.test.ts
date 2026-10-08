import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { encodeTerminalStreamJson } from '../../../../shared/terminal-stream-protocol'
import {
  decodeSnapshotInfo,
  pushedSnapshotKeepsLocalScrollback
} from '../../runtime/remote-runtime-terminal-snapshot-state'
import { writeHeadlessTerminal } from './pty-connection-test-async'
import { buildFoldedImageReplayWrites } from './terminal-snapshot-replay-paint'

const COLS = 40
const ROWS = 5

function lines(term: Terminal): string[] {
  const buffer = term.buffer.normal
  return Array.from(
    { length: buffer.length },
    (_, row) => buffer.getLine(row)?.translateToString(true) ?? ''
  ).filter((line) => line.length > 0)
}

async function paneWithHistory(count: number): Promise<Terminal> {
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true })
  await writeHeadlessTerminal(
    term,
    Array.from({ length: count }, (_, i) => `HISTORY-${i}`).join('\r\n')
  )
  return term
}

async function replay(term: Terminal, image: string, keepScrollback: boolean): Promise<void> {
  const writes = buildFoldedImageReplayWrites(image, false, keepScrollback)
  await writeHeadlessTerminal(term, writes.preamble)
  await writeHeadlessTerminal(term, writes.payload)
}

function snapshotInfo(fields: Record<string, unknown>) {
  return decodeSnapshotInfo(encodeTerminalStreamJson({ cols: COLS, rows: ROWS, ...fields }))
}

describe('remote snapshot replay keeps history the image cannot replace (#14593)', () => {
  it('reads scrollbackRows off the wire and treats absence as an older host', () => {
    expect(snapshotInfo({ scrollbackRows: 1000 })?.scrollbackRows).toBe(1000)
    expect(snapshotInfo({ scrollbackRows: -1 })?.scrollbackRows).toBeUndefined()
    expect(snapshotInfo({ scrollbackRows: 1.5 })?.scrollbackRows).toBeUndefined()
    expect(pushedSnapshotKeepsLocalScrollback(snapshotInfo({}))).toBe(true)
    expect(pushedSnapshotKeepsLocalScrollback(snapshotInfo({ scrollbackRows: 0 }))).toBe(true)
    expect(pushedSnapshotKeepsLocalScrollback(snapshotInfo({ scrollbackRows: 1000 }))).toBe(false)
  })

  it('a screen-only image repaints the screen and keeps the scrollback above it', async () => {
    const term = await paneWithHistory(40)
    await replay(term, 'SCREEN-A\r\nSCREEN-B', true)
    const after = lines(term)
    expect(after.slice(0, 35)).toEqual(Array.from({ length: 35 }, (_, i) => `HISTORY-${i}`))
    expect(after.slice(-2)).toEqual(['SCREEN-A', 'SCREEN-B'])
    term.dispose()
  })

  it('an image that carries history still replaces the scrollback without duplicating it', async () => {
    const term = await paneWithHistory(40)
    const image = Array.from({ length: 12 }, (_, i) => `HOST-${i}`).join('\r\n')
    await replay(term, image, false)
    expect(lines(term)).toEqual(Array.from({ length: 12 }, (_, i) => `HOST-${i}`))
    term.dispose()
  })

  it('pre-TUI shell output survives a screen-only image of a running TUI (#6106)', async () => {
    const term = await paneWithHistory(20)
    // The host folds its normal screen in, then enters alt for the TUI frame.
    await replay(term, 'SHELL-SCREEN\x1b[?1049h\x1b[2J\x1b[HTUI-FRAME', true)
    expect(term.buffer.active.type).toBe('alternate')
    expect(lines(term).slice(0, 15)).toEqual(Array.from({ length: 15 }, (_, i) => `HISTORY-${i}`))
    term.dispose()
  })
})
