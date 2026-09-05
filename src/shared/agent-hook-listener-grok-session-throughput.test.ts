import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createGrokCallTextExtractor,
  createGrokLoopTimingExtractor,
  estimateGrokOutputTokens,
  readLastGrokMessageThroughput
} from './agent-hook-listener/grok-session-throughput'

const BASE = Date.parse('2026-09-02T13:56:11.030Z')

function at(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString()
}

function event(type: string, offsetMs: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts: at(offsetMs), type, ...extra })
}

function tick(phase: string, offsetMs: number): string {
  return event('phase_changed', offsetMs, { phase })
}

function assistantRow(content: string, toolArguments: string[] = []): string {
  return JSON.stringify({
    type: 'assistant',
    content,
    model_id: 'grok-4.6',
    tool_calls: toolArguments.map((args, index) => ({
      id: `call-${index}`,
      name: 'read_file',
      arguments: args
    }))
  })
}

function reasoningRow(summaryText: string, encryptedLength: number): string {
  return JSON.stringify({
    type: 'reasoning',
    id: 'rs_1',
    summary: [{ type: 'summary_text', text: summaryText }],
    encrypted_content: 'x'.repeat(encryptedLength)
  })
}

const tmpDirs: string[] = []

function writeSession(events: string[], chat: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-grok-throughput-'))
  tmpDirs.push(dir)
  writeFileSync(join(dir, 'events.jsonl'), `${events.join('\n')}\n`)
  const chatPath = join(dir, 'chat_history.jsonl')
  writeFileSync(chatPath, `${chat.join('\n')}\n`)
  return chatPath
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('grok session throughput', () => {
  it('estimates the newest completed call from its loop timing and text length', () => {
    const chatPath = writeSession(
      [
        event('turn_started', -5_000, { model_id: 'grok-4.6' }),
        event('loop_started', -4_000, { loop_index: 21 }),
        tick('streaming_reasoning', -3_000),
        event('permission_requested', -2_500),
        event('permission_resolved', -1_000),
        event('tool_started', -900, { tool: 'read_file' }),
        event('tool_completed', -100),
        event('loop_started', 0, { loop_index: 22 }),
        tick('waiting_for_model', 1),
        event('first_token', 1_513),
        tick('streaming_reasoning', 1_513),
        tick('streaming_text', 2_000),
        tick('streaming_text', 15_000),
        event('turn_ended', 15_608, { outcome: 'completed' })
      ],
      [
        JSON.stringify({ type: 'user', content: 'go' }),
        reasoningRow('short plan', 400),
        assistantRow('', ['{"target_file":"a.cpp"}']),
        JSON.stringify({ type: 'tool_result', tool_call_id: 'call-0', content: 'file body' }),
        reasoningRow('final summary', 132),
        assistantRow('x'.repeat(2121))
      ]
    )

    const result = readLastGrokMessageThroughput(chatPath)
    // Why: (2121 + 13 + 132 * 0.75) / 4 ≈ 558 tokens over the whole loop, permission waits excluded.
    expect(result).toEqual({
      messageId: `grok:${BASE}`,
      model: 'grok-4.6',
      outputTokens: 558,
      generationMs: 15_608,
      completedAt: BASE + 15_608,
      estimated: true
    })
  })

  it('ends a tool-calling loop at its permission prompt and skips a loop still streaming', () => {
    const chatPath = writeSession(
      [
        event('loop_started', 0, { loop_index: 1 }),
        tick('streaming_reasoning', 1_200),
        event('permission_requested', 9_000),
        event('permission_resolved', 40_000),
        event('tool_started', 40_100),
        event('tool_completed', 41_000),
        event('loop_started', 41_050, { loop_index: 2 }),
        tick('streaming_text', 42_000)
      ],
      [
        JSON.stringify({ type: 'user', content: 'go' }),
        reasoningRow('think', 800),
        assistantRow('', ['{"path":"x"}']),
        JSON.stringify({ type: 'tool_result', tool_call_id: 'call-0', content: 'ok' })
      ]
    )

    expect(readLastGrokMessageThroughput(chatPath)).toMatchObject({
      messageId: `grok:${BASE}`,
      generationMs: 9_000,
      // Why: (12 + 5 + 800 * 0.75) / 4 = 154.25 → 154
      outputTokens: 154
    })
  })

  it('returns undefined without a completed loop, without chat text, or without files', () => {
    const streamingOnly = writeSession(
      [event('loop_started', 0, { loop_index: 1 }), tick('streaming_text', 500)],
      [assistantRow('hello')]
    )
    expect(readLastGrokMessageThroughput(streamingOnly)).toBe(undefined)

    const noAssistant = writeSession(
      [event('loop_started', 0, { loop_index: 1 }), event('turn_ended', 2_000)],
      [JSON.stringify({ type: 'user', content: 'go' })]
    )
    expect(readLastGrokMessageThroughput(noAssistant)).toBe(undefined)

    expect(
      readLastGrokMessageThroughput(join(tmpdir(), 'orca-missing', 'chat_history.jsonl'))
    ).toBe(undefined)
  })

  it('exposes its extractors and estimate for reuse', () => {
    const timing = createGrokLoopTimingExtractor()
    expect(timing.visit('not json')).toBe(undefined)
    expect(timing.visit(event('turn_ended', 10))).toBe(undefined)
    expect(timing.visit(event('loop_started', 0, { loop_index: 3 }))).toEqual({
      loopIndex: 3,
      startedAt: BASE,
      endedAt: BASE + 10
    })

    const text = createGrokCallTextExtractor()
    expect(text.visit(assistantRow('abcd', ['{}']))).toBe(undefined)
    expect(text.visit(reasoningRow('ef', 8))).toBe(undefined)
    expect(text.visit(JSON.stringify({ type: 'tool_result' }))).toEqual({
      model: 'grok-4.6',
      visibleChars: 8,
      encryptedReasoningChars: 8
    })
    expect(text.flush()).toBe(undefined)
    expect(
      estimateGrokOutputTokens({ model: null, visibleChars: 10, encryptedReasoningChars: 8 })
    ).toBe(4)
  })
})
