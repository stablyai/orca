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

describe('backward transcript line extraction', () => {
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
})
