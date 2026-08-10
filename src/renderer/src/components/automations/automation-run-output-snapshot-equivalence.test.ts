import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  stripAnsiEscapeSequences,
  TERMINAL_CONTROL_CHARACTER_PATTERN
} from '../../../../shared/ansi-escape-sequences'
import {
  type AutomationRunOutputSnapshotBuffer,
  createAutomationRunOutputSnapshotBuffer,
  createAutomationRunOutputSnapshotFromText
} from './automation-run-output-snapshot'

const MAX_OUTPUT_SNAPSHOT_CHARS = 256 * 1024

function createShiftReferenceBuffer(): AutomationRunOutputSnapshotBuffer {
  const chunks: string[] = []
  let totalChars = 0
  let truncated = false

  return {
    append(chunk) {
      if (!chunk) {
        return
      }
      chunks.push(chunk)
      totalChars += chunk.length
      let overflowChars = totalChars - MAX_OUTPUT_SNAPSHOT_CHARS
      while (overflowChars > 0 && chunks.length > 0) {
        const firstChunk = chunks[0]
        if (firstChunk.length <= overflowChars) {
          chunks.shift()
          totalChars -= firstChunk.length
          overflowChars -= firstChunk.length
          truncated = true
          continue
        }
        chunks[0] = firstChunk.slice(overflowChars)
        totalChars -= overflowChars
        truncated = true
        overflowChars = 0
      }
    },
    snapshot() {
      const content = stripAnsiEscapeSequences(chunks.join(''))
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(TERMINAL_CONTROL_CHARACTER_PATTERN, '')
        .trim()
      return createAutomationRunOutputSnapshotFromText(content, truncated)
    }
  }
}

function createSeededRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296
    return state
  }
}

describe('automation run output snapshot queue equivalence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('matches the shift reference across seeded chunk and control-sequence boundaries', () => {
    const random = createSeededRandom(0xc0ffee)
    const tokens = [
      'plain-output-',
      '\u001b[31mred\u001b[0m',
      '\u001b]0;title\u001b\\',
      '\r\n',
      '\ud83d\ude00',
      '\ud83d',
      '\ude00',
      '\u0007',
      '   '
    ]
    let source = ''
    for (let index = 0; index < 80_000; index += 1) {
      source += tokens[random() % tokens.length]
    }

    const reference = createShiftReferenceBuffer()
    const candidate = createAutomationRunOutputSnapshotBuffer()
    let chunkCount = 0
    for (let offset = 0; offset < source.length; ) {
      const chunkLength = 1 + (random() % 73)
      const chunk = source.slice(offset, offset + chunkLength)
      reference.append(chunk)
      candidate.append(chunk)
      offset += chunkLength
      chunkCount += 1
      if (chunkCount % 2_048 === 0) {
        expect(candidate.snapshot()).toEqual(reference.snapshot())
      }
    }

    expect(candidate.snapshot()).toEqual(reference.snapshot())
  })
})
