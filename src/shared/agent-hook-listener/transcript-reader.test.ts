import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as NodeFs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  findLastExtractedTranscriptLineText,
  readFirstTranscriptRecord,
  TRANSCRIPT_CHUNK_BYTES
} from './transcript-reader'
import { extractAssistantTextFromLine } from './transcript-entry-text'

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>()
  return {
    ...fs,
    openSync: vi.fn(fs.openSync),
    readSync: vi.fn(fs.readSync),
    closeSync: vi.fn(fs.closeSync)
  }
})

it('reads the same bounded first-record prefix with N and 10N later records and closes the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'transcript-first-record-'))
  const transcriptPath = join(dir, 'transcript.jsonl')
  const first = {
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    content: 'x'.repeat(TRANSCRIPT_CHUNK_BYTES)
  }
  const later = `${JSON.stringify({ source: 'SYSTEM', content: 'y'.repeat(512) })}\n`
  try {
    for (const records of [1000, 10_000]) {
      writeFileSync(transcriptPath, `${JSON.stringify(first)}\n${later.repeat(records)}`)
      vi.mocked(openSync).mockClear()
      vi.mocked(readSync).mockClear()
      vi.mocked(closeSync).mockClear()

      // Call only the origin reader, excluding the unrelated reverse/prompt reader's IO.
      expect(readFirstTranscriptRecord(transcriptPath)).toEqual(first)

      expect(openSync).toHaveBeenCalledExactlyOnceWith(transcriptPath, 'r')
      expect(vi.mocked(readSync).mock.results.map((result) => result.value)).toEqual([
        TRANSCRIPT_CHUNK_BYTES,
        TRANSCRIPT_CHUNK_BYTES
      ])
      const fd = vi.mocked(openSync).mock.results[0].value
      expect(closeSync).toHaveBeenCalledExactlyOnceWith(fd)
      expect(() => fstatSync(fd)).toThrow(expect.objectContaining({ code: 'EBADF' }))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function expectedLines(text: string): string[] {
  return text
    .split('\n')
    .toReversed()
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

describe('backward transcript line extraction', () => {
  it.each(['', '\n', '\n\n', '\r\n', ' \t\r\n', '\na\n', 'a\nb', '😀\r\n漢字'])(
    'visits each nonblank line once in reverse order for %j',
    (text) => {
      const seen: string[] = []
      expect(
        findLastExtractedTranscriptLineText(text, (line) => {
          seen.push(line)
          return undefined
        })
      ).toBeUndefined()
      expect(seen).toEqual(expectedLines(text))
    }
  )

  it('preserves line order and early return across generated delimiters', () => {
    let seed = 29
    const fragments = ['a', '\n', '\r\n', ' ', '\t', '😀', '\u2028', '\0']
    for (let sample = 0; sample < 1000; sample++) {
      let text = ''
      for (let i = 0; i < sample % 100; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        text += fragments[seed % fragments.length]
      }
      const lines = expectedLines(text)
      const stop = sample % (lines.length + 1)
      const seen: string[] = []
      const result = findLastExtractedTranscriptLineText(text, (line) => {
        seen.push(line)
        return seen.length === stop + 1 ? line : undefined
      })
      expect(seen).toEqual(lines.slice(0, stop + 1))
      expect(result).toBe(lines[stop])
    }
  })

  it('returns the newest assistant message behind a long tool line', () => {
    const message = JSON.stringify({ role: 'assistant', content: 'latest 😀' })
    const tool = JSON.stringify({ role: 'tool', content: 'x'.repeat(256 * 1024) })
    expect(
      findLastExtractedTranscriptLineText(
        `\n{"role":"assistant","content":"older"}\r\n${message}\r\n${tool}\n`,
        extractAssistantTextFromLine
      )
    ).toBe('latest 😀')
  })

  it('treats an empty extracted string as a result and stops before older lines', () => {
    const seen: string[] = []
    expect(
      findLastExtractedTranscriptLineText('older\nlatest\n', (line) => {
        seen.push(line)
        return ''
      })
    ).toBe('')
    expect(seen).toEqual(['latest'])
  })
})
