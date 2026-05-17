import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAutomationRunOutputSnapshotBuffer } from './automation-run-output-snapshot'

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
})
