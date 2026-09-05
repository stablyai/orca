import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createClaudeMessageThroughputExtractor,
  parseClaudeTranscriptThroughputRow,
  readLastClaudeMessageThroughput
} from './agent-hook-listener/claude-transcript-throughput'

const BASE = Date.parse('2026-09-02T18:09:40.208Z')

function at(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString()
}

function assistantRow(args: {
  uuid: string
  parentUuid: string | null
  messageId: string
  offsetMs: number
  outputTokens?: number
  block?: string
  isSidechain?: boolean
}): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: args.uuid,
    parentUuid: args.parentUuid,
    timestamp: at(args.offsetMs),
    isSidechain: args.isSidechain ?? false,
    message: {
      id: args.messageId,
      model: 'claude-fable-5-1',
      role: 'assistant',
      content: [{ type: args.block ?? 'text', text: 'hi' }],
      ...(args.outputTokens === undefined
        ? {}
        : { usage: { input_tokens: 101, output_tokens: args.outputTokens } })
    }
  })
}

function row(
  type: string,
  uuid: string | null,
  parentUuid: string | null,
  offsetMs: number
): string {
  return JSON.stringify({ type, uuid, parentUuid, timestamp: at(offsetMs) })
}

const tmpDirs: string[] = []

function writeTranscript(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-claude-throughput-'))
  tmpDirs.push(dir)
  const transcriptPath = join(dir, 'transcript.jsonl')
  writeFileSync(transcriptPath, `${lines.join('\n')}\n`)
  return transcriptPath
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('claude transcript throughput', () => {
  it('starts at the first block’s parent row even when later-stamped rows were written mid-stream', () => {
    // Why: the real shape — reminders are attached right before the request, queued input lands
    // while the model streams, and the block rows are flushed together with their own timestamps.
    const transcriptPath = writeTranscript([
      assistantRow({
        uuid: 'p1',
        parentUuid: null,
        messageId: 'msg_prev',
        offsetMs: -4_000,
        outputTokens: 900,
        block: 'tool_use'
      }),
      row('user', 'u0', 'p1', 0),
      row('attachment', 'att0', 'u0', 17_821),
      row('attachment', 'att1', 'att0', 17_823),
      row('queue-operation', null, null, 37_087),
      row('queue-operation', null, null, 77_803),
      row('queue-operation', null, null, 115_171),
      assistantRow({
        uuid: 't1',
        parentUuid: 'att1',
        messageId: 'msg_1',
        offsetMs: 111_652,
        outputTokens: 8393,
        block: 'thinking'
      }),
      assistantRow({
        uuid: 't2',
        parentUuid: 't1',
        messageId: 'msg_1',
        offsetMs: 113_429,
        outputTokens: 8393,
        block: 'thinking'
      }),
      assistantRow({
        uuid: 'w1',
        parentUuid: 't2',
        messageId: 'msg_1',
        offsetMs: 132_437,
        outputTokens: 8393,
        block: 'tool_use'
      }),
      assistantRow({
        uuid: 'r1',
        parentUuid: 'w1',
        messageId: 'msg_1',
        offsetMs: 132_685,
        outputTokens: 8393,
        block: 'tool_use'
      }),
      row('attachment', 'att2', 'r1', 132_662),
      row('user', 'u1', 'w1', 132_902),
      row('user', 'u2', 'r1', 133_394)
    ])

    expect(readLastClaudeMessageThroughput(transcriptPath)).toEqual({
      messageId: 'msg_1',
      model: 'claude-fable-5-1',
      outputTokens: 8393,
      generationMs: 132_685 - 17_823,
      completedAt: BASE + 132_685
    })
  })

  it('spans a message whose tool results are interleaved with its blocks', () => {
    const transcriptPath = writeTranscript([
      row('user', 'u0', null, 0),
      assistantRow({
        uuid: 'a1',
        parentUuid: 'u0',
        messageId: 'msg_1',
        offsetMs: 2_574,
        outputTokens: 2108,
        block: 'tool_use'
      }),
      row('user', 'r1', 'a1', 3_015),
      assistantRow({
        uuid: 'a2',
        parentUuid: 'r1',
        messageId: 'msg_1',
        offsetMs: 5_557,
        outputTokens: 2108,
        block: 'tool_use'
      }),
      row('user', 'r2', 'a2', 6_033),
      assistantRow({
        uuid: 'a3',
        parentUuid: 'r2',
        messageId: 'msg_1',
        offsetMs: 11_645,
        outputTokens: 2108,
        block: 'tool_use'
      }),
      row('user', 'r3', 'a3', 12_100)
    ])

    expect(readLastClaudeMessageThroughput(transcriptPath)).toMatchObject({
      messageId: 'msg_1',
      generationMs: 11_645,
      completedAt: BASE + 11_645
    })
  })

  it('prefers the last user row when the parent attachment carries a stale timestamp', () => {
    const transcriptPath = writeTranscript([
      row('user', 'u0', null, 10_000),
      row('attachment', 'queued', 'u0', 2_000),
      assistantRow({
        uuid: 'a1',
        parentUuid: 'queued',
        messageId: 'msg_1',
        offsetMs: 16_000,
        outputTokens: 300
      })
    ])

    expect(readLastClaudeMessageThroughput(transcriptPath)).toMatchObject({
      generationMs: 6_000
    })
  })

  it('falls back to the last user row, then to the previous message, when the parent is missing', () => {
    const missingParent = writeTranscript([
      row('user', 'u0', null, 0),
      row('progress', 'pr', null, 500),
      assistantRow({
        uuid: 'a1',
        parentUuid: 'missing',
        messageId: 'msg_1',
        offsetMs: 3_500,
        outputTokens: 50
      })
    ])
    expect(readLastClaudeMessageThroughput(missingParent)).toMatchObject({ generationMs: 3_500 })

    const retryAfterError = writeTranscript([
      assistantRow({ uuid: 'e1', parentUuid: null, messageId: 'msg_err', offsetMs: 0 }),
      assistantRow({
        uuid: 'a1',
        parentUuid: 'missing',
        messageId: 'msg_1',
        offsetMs: 2_500,
        outputTokens: 40
      })
    ])
    expect(readLastClaudeMessageThroughput(retryAfterError)).toMatchObject({ generationMs: 2_500 })
  })

  it('skips sidechain rows and usage-less rows when picking the newest message', () => {
    const transcriptPath = writeTranscript([
      row('user', 'u0', null, 0),
      assistantRow({
        uuid: 'a1',
        parentUuid: 'u0',
        messageId: 'msg_1',
        offsetMs: 4_000,
        outputTokens: 120
      }),
      row('user', 'u1', 'a1', 5_000),
      assistantRow({ uuid: 'e1', parentUuid: 'u1', messageId: 'msg_err', offsetMs: 6_000 }),
      assistantRow({
        uuid: 's1',
        parentUuid: 'x',
        messageId: 'msg_side',
        offsetMs: 7_000,
        outputTokens: 999,
        isSidechain: true
      })
    ])

    expect(readLastClaudeMessageThroughput(transcriptPath)).toMatchObject({
      messageId: 'msg_1',
      outputTokens: 120,
      generationMs: 4_000
    })
  })

  it('bounds the walk once the start is known', () => {
    const filler = Array.from({ length: 600 }, (_, index) =>
      row('progress', `pr${index}`, null, 100 + index)
    )
    const transcriptPath = writeTranscript([
      ...filler,
      row('user', 'u0', null, 1_000),
      assistantRow({
        uuid: 'a1',
        parentUuid: 'u0',
        messageId: 'msg_1',
        offsetMs: 3_000,
        outputTokens: 40
      })
    ])

    expect(readLastClaudeMessageThroughput(transcriptPath)).toMatchObject({ generationMs: 2_000 })
  })

  it('returns undefined without a measurable message', () => {
    expect(readLastClaudeMessageThroughput(join(tmpdir(), 'orca-missing-transcript.jsonl'))).toBe(
      undefined
    )
    const noUsage = writeTranscript([
      row('user', 'u0', null, 0),
      assistantRow({ uuid: 'a1', parentUuid: 'u0', messageId: 'msg_1', offsetMs: 500 })
    ])
    expect(readLastClaudeMessageThroughput(noUsage)).toBe(undefined)
    const sameInstant = writeTranscript([
      row('user', 'u0', null, 0),
      assistantRow({
        uuid: 'a1',
        parentUuid: 'u0',
        messageId: 'msg_1',
        offsetMs: 0,
        outputTokens: 5
      })
    ])
    expect(readLastClaudeMessageThroughput(sameInstant)).toBe(undefined)
    const noStart = writeTranscript([
      row('progress', 'pr', null, 0),
      assistantRow({
        uuid: 'a1',
        parentUuid: 'missing',
        messageId: 'msg_1',
        offsetMs: 900,
        outputTokens: 5
      })
    ])
    expect(readLastClaudeMessageThroughput(noStart)).toBe(undefined)
    expect(createClaudeMessageThroughputExtractor().flush()).toBe(undefined)
  })

  it('parses rows defensively', () => {
    expect(parseClaudeTranscriptThroughputRow('not json')).toBe(null)
    expect(parseClaudeTranscriptThroughputRow(JSON.stringify({ type: 'user' }))).toBe(null)
    expect(
      parseClaudeTranscriptThroughputRow(
        JSON.stringify({
          type: 'assistant',
          timestamp: at(1_500),
          message: { id: 'msg_1', usage: { output_tokens: 'many' } }
        })
      )
    ).toEqual({
      type: 'assistant',
      uuid: null,
      parentUuid: null,
      timestamp: BASE + 1_500,
      messageId: 'msg_1',
      model: null,
      outputTokens: 0
    })
  })
})
