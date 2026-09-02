import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAutomationRunOutputSnapshotBuffer,
  createAutomationRunOutputSnapshotFromText,
  selectAutomationRunOutputSnapshot
} from './automation-run-output-snapshot'

describe('automation run output snapshot buffer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-16T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('captures a plain-text snapshot from terminal chunks', () => {
    const buffer = createAutomationRunOutputSnapshotBuffer()

    buffer.append('\u001b[32mDone\u001b[0m\r\n')
    buffer.append('All checks passed')

    expect(buffer.snapshot()).toEqual({
      format: 'plain_text',
      content: 'Done\nAll checks passed',
      capturedAt: new Date('2026-05-16T12:00:00Z').getTime(),
      truncated: false
    })
  })

  it('returns null for empty terminal noise', () => {
    const buffer = createAutomationRunOutputSnapshotBuffer()

    buffer.append('\u001b[?25h\r')

    expect(buffer.snapshot()).toBeNull()
  })

  it('strips ST-terminated OSC title and progress frames from Codex TUI output', () => {
    const buffer = createAutomationRunOutputSnapshotBuffer()

    buffer.append('\u001b]0;\u2834 orca q\u2022Working q\u001b\\')
    buffer.append('\u001b]9;4;3;Working\u001b\\')
    buffer.append('\u001b[32m\u2022 Ran agent-slack channel list --all\u001b[0m\r\n')
    buffer.append('\u2514 { "name": "stably-bugs-and-feedback" }\r\n')

    expect(buffer.snapshot()).toMatchObject({
      format: 'plain_text',
      content:
        '\u2022 Ran agent-slack channel list --all\n\u2514 { "name": "stably-bugs-and-feedback" }',
      truncated: false
    })
  })

  it('strips CSI sequences with intermediate bytes', () => {
    const buffer = createAutomationRunOutputSnapshotBuffer()

    buffer.append('\u001b[2 q\u001b[?25lDone\u001b[?25h')

    expect(buffer.snapshot()).toMatchObject({
      content: 'Done'
    })
  })

  it('strips digit-final ESC cursor save and restore sequences', () => {
    const buffer = createAutomationRunOutputSnapshotBuffer()

    buffer.append('\u001b7Loading\u001b8Done')

    expect(buffer.snapshot()).toMatchObject({
      content: 'LoadingDone'
    })
  })

  it('keeps the tail of earlier chunks when a later chunk crosses the size cap', () => {
    const buffer = createAutomationRunOutputSnapshotBuffer()

    buffer.append('A'.repeat(256 * 1024))
    buffer.append('TAIL')

    const snapshot = buffer.snapshot()
    expect(snapshot?.content).toHaveLength(256 * 1024)
    expect(snapshot?.content.startsWith('A')).toBe(true)
    expect(snapshot?.content.endsWith('TAIL')).toBe(true)
    expect(snapshot?.truncated).toBe(true)
  })

  it('preserves FIFO content through compaction and later partial trimming', () => {
    const buffer = createAutomationRunOutputSnapshotBuffer()
    const chunkCount = (256 * 1024) / 16
    const replacementChunks = Array.from({ length: chunkCount }, (_, index) =>
      index.toString(36).padStart(4, '0').repeat(4)
    )

    for (let index = 0; index < chunkCount; index += 1) {
      buffer.append('A'.repeat(16))
    }
    for (const chunk of replacementChunks) {
      buffer.append(chunk)
    }

    const replacedContent = replacementChunks.join('')
    expect(buffer.snapshot()).toMatchObject({ content: replacedContent, truncated: true })

    buffer.append('TAIL')
    expect(buffer.snapshot()).toMatchObject({
      content: `${replacedContent.slice(4)}TAIL`,
      truncated: true
    })
  })

  it('strips escape sequences joined across chunk boundaries', () => {
    const buffer = createAutomationRunOutputSnapshotBuffer()

    buffer.append('Before\u001b]0;hidden')
    buffer.append('\u001b\\After')

    expect(buffer.snapshot()).toMatchObject({ content: 'BeforeAfter', truncated: false })
  })

  it('retains the same UTF-16 tail when overflow splits a surrogate pair', () => {
    const buffer = createAutomationRunOutputSnapshotBuffer()
    const initial = '\ud83d\ude00'.repeat((256 * 1024) / 2)

    buffer.append(initial)
    buffer.append('x')

    expect(buffer.snapshot()).toMatchObject({
      content: `${initial.slice(1)}x`,
      truncated: true
    })
  })

  it('owns the exact UTF-16 tail of one oversized chunk', () => {
    const buffer = createAutomationRunOutputSnapshotBuffer()
    const retained = `\ude00${'A'.repeat(256 * 1024 - 2)}\ud83d`

    buffer.append('older output')
    buffer.append(`discarded prefix${retained}`)

    expect(buffer.snapshot()).toMatchObject({ content: retained, truncated: true })

    buffer.append('TAIL')
    expect(buffer.snapshot()).toMatchObject({
      content: `${retained.slice(4)}TAIL`,
      truncated: true
    })
  })

  it('creates a saved snapshot from agent transcript text', () => {
    expect(createAutomationRunOutputSnapshotFromText('\nFinal summary.\n')).toEqual({
      format: 'plain_text',
      content: 'Final summary.',
      capturedAt: new Date('2026-05-16T12:00:00Z').getTime(),
      truncated: false
    })
  })

  it('prefers agent transcript text over raw terminal redraw output', () => {
    const rawTerminalSnapshot = createAutomationRunOutputSnapshotFromText(
      'q;\u2834 orca q\u2022Working q q'
    )

    expect(selectAutomationRunOutputSnapshot('Posted to #releases.', rawTerminalSnapshot)).toEqual({
      format: 'plain_text',
      content: 'Posted to #releases.',
      capturedAt: new Date('2026-05-16T12:00:00Z').getTime(),
      truncated: false
    })
  })
})
