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
  return JSON.stringify({ paneKey, source: 'codex', payload: {}, receivedAt: Date.now() })
}

describe('readSpoolFile', () => {
  it('leaves a trailing line without its newline unconsumed', () => {
    const complete = `${record('café😀')}\n`
    const result = readSpoolFile(write(`${complete}${record('b')}`))

    expect(result.records.map((entry) => entry.paneKey)).toEqual(['café😀'])
    expect(result.consumed).toBe(Buffer.byteLength(complete))
  })

  it('skips blank lines without consuming less than the bytes they occupy', () => {
    const contents = `${record('a')}\n\n\n${record('b')}\n`
    const result = readSpoolFile(write(contents))

    expect(result.records.map((entry) => entry.paneKey)).toEqual(['a', 'b'])
    expect(result.consumed).toBe(Buffer.byteLength(contents))
  })
})
