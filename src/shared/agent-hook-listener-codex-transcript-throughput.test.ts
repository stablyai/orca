import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createCodexMessageThroughputExtractor,
  parseCodexRolloutThroughputRow,
  readLastCodexMessageThroughput
} from './agent-hook-listener/codex-transcript-throughput'

const BASE = Date.parse('2026-09-02T11:52:40.631Z')

function at(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString()
}

function row(type: string, payload: Record<string, unknown>, offsetMs: number): string {
  return JSON.stringify({ timestamp: at(offsetMs), type, payload })
}

function tokenCount(offsetMs: number, outputTokens: number, totalOutput: number): string {
  return row(
    'event_msg',
    {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 1000,
          output_tokens: totalOutput,
          total_tokens: 1000 + totalOutput
        },
        last_token_usage: {
          input_tokens: 500,
          output_tokens: outputTokens,
          total_tokens: 500 + outputTokens
        }
      },
      rate_limits: null
    },
    offsetMs
  )
}

/** The real rollout shape: model rows, then the tool output, then the call's token_count. */
function realCallSequence(): string[] {
  return [
    row('response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: 'ok' }, 0),
    tokenCount(0, 184, 184),
    row('event_msg', { type: 'agent_reasoning', text: 'thinking' }, 22_074),
    row('response_item', { type: 'reasoning', summary: [] }, 22_087),
    row('response_item', { type: 'reasoning', summary: [] }, 24_346),
    row('response_item', { type: 'custom_tool_call', name: 'exec', input: 'ls' }, 29_293),
    row(
      'response_item',
      { type: 'custom_tool_call_output', call_id: 'c2', output: 'files' },
      32_443
    ),
    tokenCount(32_444, 696, 880),
    tokenCount(33_213, 696, 880),
    row('event_msg', { type: 'task_complete', last_agent_message: 'done' }, 33_226)
  ]
}

const tmpDirs: string[] = []

function writeRollout(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-codex-throughput-'))
  tmpDirs.push(dir)
  const rolloutPath = join(dir, 'rollout.jsonl')
  writeFileSync(rolloutPath, `${lines.join('\n')}\n`)
  return rolloutPath
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('codex rollout throughput', () => {
  it('measures the newest call from the previous snapshot to its last model row', () => {
    expect(readLastCodexMessageThroughput(writeRollout(realCallSequence()))).toEqual({
      messageId: 'codex:1000:880:1880',
      model: null,
      outputTokens: 696,
      generationMs: 29_293,
      completedAt: BASE + 29_293
    })
  })

  it('ends a final assistant message at its message row and starts it at the tool output', () => {
    const rolloutPath = writeRollout([
      row('response_item', { type: 'function_call_output', call_id: 'c1', output: 'ok' }, 0),
      tokenCount(1, 120, 120),
      row('event_msg', { type: 'agent_message', message: 'All done.' }, 6_000),
      row('response_item', { type: 'message', role: 'assistant', content: [] }, 6_000),
      tokenCount(6_010, 40, 160),
      row('event_msg', { type: 'task_complete' }, 6_020)
    ])

    expect(readLastCodexMessageThroughput(rolloutPath)).toMatchObject({
      messageId: 'codex:1000:160:1160',
      outputTokens: 40,
      generationMs: 5_999,
      completedAt: BASE + 6_000
    })
  })

  it('starts the first call of a turn at the user message and ignores rate-limit snapshots', () => {
    const rolloutPath = writeRollout([
      row('turn_context', { cwd: 'C:/repo', model: 'gpt-5.5' }, 0),
      row('event_msg', { type: 'user_message', message: 'go' }, 100),
      row('response_item', { type: 'message', role: 'user', content: [] }, 100),
      row('event_msg', { type: 'token_count', info: null, rate_limits: {} }, 150),
      row('response_item', { type: 'reasoning', summary: [] }, 3_000),
      row('response_item', { type: 'function_call', name: 'shell', arguments: '{}' }, 4_100),
      row('response_item', { type: 'function_call_output', call_id: 'c1', output: 'ok' }, 4_500),
      tokenCount(4_501, 90, 90)
    ])

    expect(readLastCodexMessageThroughput(rolloutPath)).toMatchObject({
      outputTokens: 90,
      generationMs: 4_000,
      completedAt: BASE + 4_100
    })
  })

  it('returns undefined without a measurable call', () => {
    expect(readLastCodexMessageThroughput(join(tmpdir(), 'orca-missing-rollout.jsonl'))).toBe(
      undefined
    )
    const snapshotOnly = writeRollout([tokenCount(0, 50, 50)])
    expect(readLastCodexMessageThroughput(snapshotOnly)).toBe(undefined)
    const noModelRows = writeRollout([
      row('response_item', { type: 'function_call_output', call_id: 'c1', output: 'ok' }, 0),
      tokenCount(5, 50, 50)
    ])
    expect(readLastCodexMessageThroughput(noModelRows)).toBe(undefined)
    expect(createCodexMessageThroughputExtractor().flush()).toBe(undefined)
  })

  it('classifies rows defensively', () => {
    expect(parseCodexRolloutThroughputRow('nope')).toBe(null)
    expect(parseCodexRolloutThroughputRow(JSON.stringify({ type: 'event_msg' }))).toBe(null)
    expect(parseCodexRolloutThroughputRow(tokenCount(10, 5, 5))).toEqual({
      kind: 'boundary',
      timestamp: BASE + 10,
      lastOutputTokens: 5,
      totalsKey: '1000:5:1005'
    })
    expect(
      parseCodexRolloutThroughputRow(
        row('response_item', { type: 'message', role: 'assistant' }, 1)
      )
    ).toMatchObject({ kind: 'model' })
    expect(
      parseCodexRolloutThroughputRow(row('response_item', { type: 'message', role: 'user' }, 1))
    ).toMatchObject({ kind: 'boundary' })
    expect(
      parseCodexRolloutThroughputRow(row('event_msg', { type: 'token_count', info: null }, 1))
    ).toMatchObject({ kind: 'skip' })
  })
})
