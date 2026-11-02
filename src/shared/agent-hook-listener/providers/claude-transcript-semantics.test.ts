import { mkdtemp, writeFile, appendFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClaudeTranscriptCursor, readClaudeTranscriptChunk } from './claude-transcript-cursor'
import {
  readClaudeHelperEvidence,
  readClaudeChildPrompts,
  type ClaudeChildTranscript,
  type ClaudeHelperTranscriptEvidence
} from './claude-helper-transcript-evidence'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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
  it('carries a record split across chunks without dropping a prefix or UTF-8', async () => {
    const path = join(dir, 'split.jsonl')
    const line = `${JSON.stringify({ type: 'system', subtype: 'agents_killed', timestamp: stamp(1), text: 'é' })}\n`
    await writeFile(path, line)
    const cursor = createClaudeTranscriptCursor(path)
    const records: Record<string, unknown>[] = []
    for (let i = 0; i < 50; i++) {
      const result = await readClaudeTranscriptChunk(cursor, 7)
      records.push(...(result?.records ?? []))
      if (result?.caughtUp) {
        break
      }
    }
    const evidence: ClaudeHelperTranscriptEvidence = {
      observedAt: now,
      launches: new Map(),
      resumedAt: new Map()
    }
    readClaudeHelperEvidence(evidence, records)
    expect(evidence.killedAt).toBe(now + 1)
  })

  it('skips one overlong line through its newline and retains the following kill', async () => {
    const path = join(dir, 'oversize.jsonl')
    await writeFile(path, `${'x'.repeat(1024 * 1024 + 10)}\n${kill()}`)
    const cursor = createClaudeTranscriptCursor(path)
    const first = await readClaudeTranscriptChunk(cursor)
    const next = await readClaudeTranscriptChunk(cursor)
    expect(first?.records).toEqual([])
    expect(next?.records).toHaveLength(1)
  })

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

it('consumes every settled launch correlation at N and 10N without inventing failed resumes', () => {
  for (const count of [10, 100]) {
    const evidence = {
      observedAt: now,
      resumedAt: new Map<string, number>(),
      launches: new Map<string, number>()
    }
    for (let index = 0; index < count; index++) {
      for (const outcome of ['sync', 'failed', 'async', 'missing-time']) {
        const id = `${outcome}-${index}`
        readClaudeHelperEvidence(evidence, [
          {
            type: 'assistant',
            timestamp: stamp(index),
            message: { content: [{ type: 'tool_use', name: 'Agent', id }] }
          },
          {
            type: 'user',
            ...(outcome === 'missing-time' ? {} : { timestamp: stamp(index + 1) }),
            toolUseResult: { isAsync: outcome === 'async' || outcome === 'failed', agentId: id },
            message: {
              content: [{ type: 'tool_result', tool_use_id: id, is_error: outcome === 'failed' }]
            }
          }
        ])
      }
    }
    expect(evidence.launches.size).toBe(0)
    expect([...evidence.resumedAt.keys()]).toEqual(
      Array.from({ length: count }, (_, i) => `async-${i}`)
    )
  }
})

it('matches complete JSON evidence on captured and adversarial final values without provisional facts', async () => {
  const captured = await Promise.all(
    ['parent', 'child'].map(async (stream) =>
      (
        await readFile(
          new URL(`../../__fixtures__/claude-helper-kill-2.1.310-${stream}.jsonl`, import.meta.url),
          'utf8'
        )
      )
        .trim()
        .split('\n')
    )
  )
  const base = `"type":"user","timestamp":${JSON.stringify(stamp(20))}`
  const huge = ' '.repeat(300_000)
  const raw = [
    ...captured.flat(),
    `{${base},"message":{"content":"${huge}real é😀"}}`,
    `{${base},"message":{"content":[{"text":"x","type":"text"},{"type":"tool_result"}]}}`,
    `{${base},"message":{"content":[{"type":"text","text":"<unknown-tag>real"}]},"isMeta":true}`,
    `{${base},"message":{"content":"real"},"isCompactSummary":true,"isCompactSummary":false}`,
    `{${base},"message":{"content":"real"},"message":null}`,
    `{${base},"message":{"content":[{"type":"text","text":"real"}],"content":false}}`,
    `{${base},"message":{"content":"injected","content":[{"type":"text","text":"[Request interrupted by user]"}]}}`,
    `{${base},"message":{"content":[{"type":"tool_result","type":"text","text":"real"}]}}`,
    `{${base},"message":{"content":[{"type":"text","text":"real","text":null}]}}`,
    `{${base},"message":{"content":"real"},"${'unknown'.repeat(60_000)}":[[[{"ignored":"${huge}"}]]]}`,
    `{${base},"message":{"content":"\uFEFF\t\u00a0"}}`,
    `{${base},"message":{"content":"\u0085"}}`,
    `{${base},"message":{"content":"real"},"type":"system","subtype":"agents_killed"}`,
    `{"type":"assistant","timestamp":${JSON.stringify(stamp(20))},"message":{"content":[{"type":"tool_use","name":"Task","id":"use","input":"${huge}"}]}}`,
    `{"type":"user","toolUseResult":{"isAsync":true,"agentId":"a123"},"message":{"content":[{"type":"tool_result","tool_use_id":"use","is_error":false}]}}`,
    `{"type":"user","toolUseResult":{"isAsync":true,"agentId":"a123"},"toolUseResult":3,"message":{"content":[{"type":"tool_result","tool_use_id":"use"}]}}`,
    `{"type":"user","toolUseResult":{"isAsync":true,"agentId":"a123"},"message":{"content":[{"type":"tool_result","tool_use_id":"use","is_error":false,"is_error":true}]}}`,
    `{"type":"user","toolUseResult":{"isAsync":true,"isAsync":false,"agentId":"a123"},"message":{"content":[{"type":"tool_result","tool_use_id":"use"}]}}`,
    `{${base},"message":{"content":[{"type":"text","text":"real"}],"content":null},"message":{"content":"new final message"}}`,
    `{${base},"message":{"content":"real"},"timestamp${'x'.repeat(300_000)}":"1900-01-01","ignored":1${'0'.repeat(300_000)}}`,
    JSON.stringify({
      type: 'user',
      timestamp: stamp(20),
      message: { content: `${' '.repeat(65)}[Request interrupted by user]` }
    }),
    `{"type":"system","subtype":"agents_killed","timestamp":${JSON.stringify(stamp(30))}} trailing`,
    `{${base},"message":{"content":"real"},"bad":[1,]}`,
    '[]',
    'null',
    'true',
    '"not an object"'
  ]
  const originals: Record<string, unknown>[] = []
  for (const line of raw) {
    try {
      const value: unknown = JSON.parse(line)
      if (isRecord(value)) {
        originals.push(value)
      }
    } catch {
      /* Intentionally invalid complete frames have no effects. */
    }
  }
  const path = join(dir, 'semantic-parity.jsonl')
  const wire = `${raw.join('\r\n')}\r\n`
  await writeFile(path, wire)
  const cursor = createClaudeTranscriptCursor(path)
  const actual: Record<string, unknown>[] = []
  while (cursor.offset < Buffer.byteLength(wire)) {
    const result = await readClaudeTranscriptChunk(cursor)
    actual.push(...(result?.records ?? []))
  }
  expect(actual).toHaveLength(originals.length)
  const evidence = (): ClaudeHelperTranscriptEvidence => ({
    observedAt: now,
    launches: new Map([['use', now + 20]]),
    resumedAt: new Map()
  })
  for (let index = 0; index < originals.length; index++) {
    const expected = evidence(),
      projected = evidence()
    readClaudeHelperEvidence(expected, [originals[index]])
    readClaudeHelperEvidence(projected, [actual[index]])
    expect(projected).toEqual(expected)
    const expectedChild: ClaudeChildTranscript = { cursor: createClaudeTranscriptCursor(path) }
    const projectedChild: ClaudeChildTranscript = { cursor: expectedChild.cursor }
    readClaudeChildPrompts(expectedChild, [originals[index]])
    readClaudeChildPrompts(projectedChild, [actual[index]])
    expect(projectedChild.promptedAt).toBe(expectedChild.promptedAt)
  }
  const expected = evidence(),
    projected = evidence()
  readClaudeHelperEvidence(expected, originals)
  readClaudeHelperEvidence(projected, actual)
  expect(projected).toEqual(expected)
  // Selected scalars/escaped keys cross every byte boundary, including UTF-8 and surrogate escapes.
  const split = `{"ty\\u0070e":"assistant","timestamp":${JSON.stringify(stamp(20))},"message":{"content":[{"type":"tool_use","name":"Agent","id":"é😀\\ud800"}]}}\n`
  await writeFile(path, split)
  const tiny = createClaudeTranscriptCursor(path)
  const selected: Record<string, unknown>[] = []
  while (tiny.offset < Buffer.byteLength(split)) {
    const chunk = await readClaudeTranscriptChunk(tiny, 1)
    selected.push(...(chunk?.records ?? []))
    if (tiny.offset < Buffer.byteLength(split)) {
      expect(chunk?.records).toEqual([])
      expect(chunk?.caughtUp).toBe(false)
    }
  }
  const final = evidence(),
    oracle = evidence()
  readClaudeHelperEvidence(final, selected)
  readClaudeHelperEvidence(oracle, [JSON.parse(split)])
  expect(final).toEqual(oracle)
})
