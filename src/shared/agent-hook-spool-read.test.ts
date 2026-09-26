import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSpoolFile } from './agent-hook-spool'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-spool-read-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(contents: string): string {
  const file = join(dir, 'spool.jsonl')
  writeFileSync(file, contents)
  return file
}

function record(paneKey: string): string {
  return JSON.stringify({ paneKey, source: 'PreToolUse', payload: {}, receivedAt: Date.now() })
}

describe('readSpoolFile', () => {
  it('leaves a trailing line without its newline unconsumed', () => {
    const complete = `${record('a')}\n`
    const result = readSpoolFile(write(`${complete}${record('b')}`))

    expect(result.records.map((entry) => entry.paneKey)).toEqual(['a'])
    // The in-flight final record must stay replayable: consumed stops at the last newline.
    expect(result.consumed).toBe(Buffer.byteLength(complete))
  })

  it('consumes through the final newline when every line is complete', () => {
    const contents = `${record('a')}\n${record('b')}\n`
    const result = readSpoolFile(write(contents))

    expect(result.records.map((entry) => entry.paneKey)).toEqual(['a', 'b'])
    expect(result.consumed).toBe(Buffer.byteLength(contents))
  })

  it('skips blank lines without consuming less than the bytes they occupy', () => {
    const contents = `${record('a')}\n\n\n${record('b')}\n`
    const result = readSpoolFile(write(contents))

    expect(result.records.map((entry) => entry.paneKey)).toEqual(['a', 'b'])
    expect(result.consumed).toBe(Buffer.byteLength(contents))
  })

  it('returns nothing for an empty file', () => {
    expect(readSpoolFile(write(''))).toEqual({ records: [], consumed: 0 })
  })

  it('returns nothing for a file that is one torn line', () => {
    expect(readSpoolFile(write(record('a'))).records).toEqual([])
    expect(readSpoolFile(write(record('a'))).consumed).toBe(0)
  })

  it('returns nothing for a missing file', () => {
    expect(readSpoolFile(join(dir, 'absent.jsonl'))).toEqual({ records: [], consumed: 0 })
  })
})
