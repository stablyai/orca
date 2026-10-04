import { describe, expect, it } from 'vitest'
import { parseClaudeStatusLineContextUsage } from './claude-statusline-context-window'
import { AGENT_CONTEXT_USAGE_MAX_TOKENS } from './agent-context-pressure'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

// null = omit the paneKey field entirely (undefined would re-trigger the default).
function formBody(payload: unknown, paneKey: string | null = PANE): Record<string, string> {
  return {
    ...(paneKey !== null ? { paneKey } : {}),
    payload: JSON.stringify(payload)
  }
}

describe('parseClaudeStatusLineContextUsage', () => {
  it('sums current_usage input-side tokens and reads the window size', () => {
    const parsed = parseClaudeStatusLineContextUsage(
      formBody({
        context_window: {
          total_input_tokens: 15_500,
          total_output_tokens: 1_200,
          context_window_size: 200_000,
          used_percentage: 8,
          current_usage: {
            input_tokens: 8_500,
            output_tokens: 1_200,
            cache_creation_input_tokens: 5_000,
            cache_read_input_tokens: 2_000
          }
        }
      })
    )
    expect(parsed).toEqual({
      paneKey: PANE,
      usage: { usedTokens: 15_500, maxTokens: 200_000, usedTokensSource: 'provider' }
    })
  })

  it('tolerates missing cache fields in current_usage', () => {
    const parsed = parseClaudeStatusLineContextUsage(
      formBody({ context_window: { current_usage: { input_tokens: 42 } } })
    )
    expect(parsed).toEqual({
      paneKey: PANE,
      usage: { usedTokens: 42, usedTokensSource: 'provider' }
    })
  })

  it('derives tokens from used_percentage x window size when current_usage is null', () => {
    // Docs: current_usage is null before the first API call and right after /compact.
    const parsed = parseClaudeStatusLineContextUsage(
      formBody({
        context_window: {
          current_usage: null,
          used_percentage: 25,
          context_window_size: 200_000
        }
      })
    )
    expect(parsed).toEqual({
      paneKey: PANE,
      usage: { usedTokens: 50_000, maxTokens: 200_000, usedTokensSource: 'derived-percent' }
    })
  })

  it('ignores total_input_tokens (cumulative on pre-2.1.132 CLIs) rather than misreport', () => {
    const parsed = parseClaudeStatusLineContextUsage(
      formBody({ context_window: { total_input_tokens: 5_000_000, current_usage: null } })
    )
    expect(parsed).toBeNull()
  })

  it('never fabricates a reading from exceeds_200k_tokens alone', () => {
    expect(
      parseClaudeStatusLineContextUsage(
        formBody({ exceeds_200k_tokens: true, model: { id: 'claude-fable-5' } })
      )
    ).toBeNull()
    expect(
      parseClaudeStatusLineContextUsage(formBody({ exceeds_200k_tokens: true, context_window: {} }))
    ).toBeNull()
  })

  it('returns null without a paneKey (rate-limit attribution needs no pane; context does)', () => {
    expect(
      parseClaudeStatusLineContextUsage(
        formBody({ context_window: { current_usage: { input_tokens: 10 } } }, null)
      )
    ).toBeNull()
    expect(
      parseClaudeStatusLineContextUsage(
        formBody({ context_window: { current_usage: { input_tokens: 10 } } }, '   ')
      )
    ).toBeNull()
  })

  it('rejects malformed bodies and payloads without throwing', () => {
    expect(parseClaudeStatusLineContextUsage(null)).toBeNull()
    expect(parseClaudeStatusLineContextUsage('raw')).toBeNull()
    expect(parseClaudeStatusLineContextUsage({ paneKey: PANE })).toBeNull()
    expect(parseClaudeStatusLineContextUsage({ paneKey: PANE, payload: 'not json' })).toBeNull()
    expect(parseClaudeStatusLineContextUsage(formBody({ context_window: 'busy' }))).toBeNull()
    expect(parseClaudeStatusLineContextUsage(formBody({ context_window: [1, 2] }))).toBeNull()
    expect(
      parseClaudeStatusLineContextUsage(
        formBody({ context_window: { current_usage: { input_tokens: 'many' } } })
      )
    ).toBeNull()
    expect(
      parseClaudeStatusLineContextUsage(
        formBody({ context_window: { current_usage: { input_tokens: -5 } } })
      )
    ).toBeNull()
  })

  it('clamps hostile token counts through the shared normalizer', () => {
    const parsed = parseClaudeStatusLineContextUsage(
      formBody({
        context_window: {
          context_window_size: AGENT_CONTEXT_USAGE_MAX_TOKENS * 4,
          current_usage: { input_tokens: AGENT_CONTEXT_USAGE_MAX_TOKENS * 2 }
        }
      })
    )
    expect(parsed?.usage).toEqual({
      usedTokens: AGENT_CONTEXT_USAGE_MAX_TOKENS,
      maxTokens: AGENT_CONTEXT_USAGE_MAX_TOKENS,
      usedTokensSource: 'provider'
    })
  })

  it('drops only an invalid window size, keeping the token reading', () => {
    const parsed = parseClaudeStatusLineContextUsage(
      formBody({
        context_window: { context_window_size: 0, current_usage: { input_tokens: 77 } }
      })
    )
    expect(parsed).toEqual({
      paneKey: PANE,
      usage: { usedTokens: 77, usedTokensSource: 'provider' }
    })
  })
})
