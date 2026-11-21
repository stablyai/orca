import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClaudeTranscriptCursor, readClaudeTranscriptChunk } from './claude-transcript-cursor'

let dir: string
const now = Date.parse('2026-10-29T12:00:00Z')
const stamp = (offset: number) => new Date(now + offset).toISOString()
const kill = (offset = 1) =>
  `${JSON.stringify({ type: 'system', subtype: 'agents_killed', timestamp: stamp(offset) })}\n`
const prompt = (offset: number) =>
  `${JSON.stringify({ type: 'user', timestamp: stamp(offset), message: { content: 'Do the work' } })}\n`
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'claude-transcript-semantics-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('forward transcript reading', () => {
  it('treats missing files as unverifiable and replacement/shrink as a new baseline', async () => {
    const path = join(dir, 'replace.jsonl')
    const cursor = createClaudeTranscriptCursor(path)
    expect(await readClaudeTranscriptChunk(cursor)).toBeUndefined()
    await writeFile(path, `${prompt(0)}${' '.repeat(200)}`)
    await readClaudeTranscriptChunk(cursor)
    await writeFile(path, kill())
    expect((await readClaudeTranscriptChunk(cursor))?.records).toEqual([])
    await appendFile(path, kill(20))
    expect((await readClaudeTranscriptChunk(cursor))?.records).toHaveLength(1)
  })
})
