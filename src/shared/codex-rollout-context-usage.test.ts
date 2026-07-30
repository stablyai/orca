// Why: locks the token_count → occupancy contract — last_token_usage composition
// (input incl. cache + output − reasoning), honest refusal of totals-only and
// null-info snapshots, and model_context_window pass-through.
import { describe, expect, it } from 'vitest'
import { readCodexRolloutContextUsage } from './codex-rollout-context-usage'

function parse(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>
}

function tokenCountLine(info: unknown): string {
  return JSON.stringify({
    timestamp: '2026-07-29T10:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'token_count', info }
  })
}

describe('readCodexRolloutContextUsage', () => {
  it('composes occupancy from last_token_usage and reads model_context_window', () => {
    const line = tokenCountLine({
      total_token_usage: {
        input_tokens: 150_000,
        cached_input_tokens: 90_000,
        output_tokens: 22_000,
        reasoning_output_tokens: 6_000,
        total_tokens: 172_000
      },
      last_token_usage: {
        input_tokens: 52_000,
        cached_input_tokens: 45_000,
        output_tokens: 900,
        reasoning_output_tokens: 400,
        total_tokens: 52_900
      },
      model_context_window: 272_000
    })
    // 52_000 input (cached already included) + (900 − 400) output kept in context.
    expect(readCodexRolloutContextUsage(parse(line))).toEqual({
      usedTokens: 52_500,
      maxTokens: 272_000,
      providerId: 'openai'
    })
  })

  it('omits maxTokens when model_context_window is absent or unusable', () => {
    const base = {
      last_token_usage: { input_tokens: 10_000, output_tokens: 500, reasoning_output_tokens: 0 }
    }
    expect(readCodexRolloutContextUsage(parse(tokenCountLine(base)))).toEqual({
      usedTokens: 10_500,
      providerId: 'openai'
    })
    for (const window of [0, -1, '272000', null]) {
      expect(
        readCodexRolloutContextUsage(
          parse(tokenCountLine({ ...base, model_context_window: window }))
        )
      ).toEqual({ usedTokens: 10_500, providerId: 'openai' })
    }
    expect(
      readCodexRolloutContextUsage({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { ...base, model_context_window: Number.NaN }
        }
      })
    ).toEqual({ usedTokens: 10_500, providerId: 'openai' })
  })

  it('never derives occupancy from cumulative totals-only snapshots', () => {
    const line = tokenCountLine({
      total_token_usage: {
        input_tokens: 1_000_000,
        cached_input_tokens: 800_000,
        output_tokens: 90_000,
        reasoning_output_tokens: 20_000,
        total_tokens: 1_090_000
      },
      model_context_window: 272_000
    })
    expect(readCodexRolloutContextUsage(parse(line))).toBeUndefined()
  })

  it('skips null-info rate-limit snapshots and non-token_count records', () => {
    expect(readCodexRolloutContextUsage(parse(tokenCountLine(null)))).toBeUndefined()
    expect(
      readCodexRolloutContextUsage(
        parse(
          JSON.stringify({
            type: 'event_msg',
            payload: { type: 'agent_message', message: 'token_count' }
          })
        )
      )
    ).toBeUndefined()
    expect(
      readCodexRolloutContextUsage(
        parse(JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.3-codex' } }))
      )
    ).toBeUndefined()
    expect(readCodexRolloutContextUsage({})).toBeUndefined()
  })

  it('rejects malformed last_token_usage instead of guessing', () => {
    for (const last of [
      'lots',
      ['not', 'usage'],
      {},
      { input_tokens: 'many' },
      { input_tokens: -5 },
      { input_tokens: Number.NaN }
    ]) {
      expect(
        readCodexRolloutContextUsage(parse(tokenCountLine({ last_token_usage: last })))
      ).toBeUndefined()
    }
  })

  it('clamps negative output/reasoning composition to the input floor and floors fractions', () => {
    const line = tokenCountLine({
      last_token_usage: {
        input_tokens: 1_000.9,
        output_tokens: 100,
        // Reasoning larger than output must not shrink the prompt-side reading.
        reasoning_output_tokens: 400
      }
    })
    expect(readCodexRolloutContextUsage(parse(line))).toEqual({
      usedTokens: 1_000,
      providerId: 'openai'
    })
  })
})
