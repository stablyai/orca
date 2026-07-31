import { describe, expect, it } from 'vitest'
import { parseClaudeStatusLineBody } from './claude-statusline-rate-limits'

function formBody(payload: unknown, configDir?: string): Record<string, string> {
  return {
    payload: JSON.stringify(payload),
    ...(configDir !== undefined ? { configDir } : {})
  }
}

describe('parseClaudeStatusLineBody', () => {
  it('extracts both windows and the session config dir', () => {
    const parsed = parseClaudeStatusLineBody(
      formBody(
        {
          rate_limits: {
            five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
            seven_day: { used_percentage: 41.2, resets_at: 1712059200 }
          }
        },
        '/home/dev/.config/managed-claude'
      )
    )
    expect(parsed).toEqual({
      configDir: '/home/dev/.config/managed-claude',
      fiveHour: { used_percentage: 23.5, resets_at: 1738425600 },
      sevenDay: { used_percentage: 41.2, resets_at: 1712059200 }
    })
  })

  it('treats a missing/empty configDir as a system-default session', () => {
    const parsed = parseClaudeStatusLineBody(
      formBody({ rate_limits: { five_hour: { used_percentage: 5 } } }, '')
    )
    expect(parsed?.configDir).toBeNull()
    expect(parsed?.fiveHour).toEqual({ used_percentage: 5, resets_at: undefined })
    expect(parsed?.sevenDay).toBeNull()
  })

  it('passes through a string resets_at so schema drift degrades gracefully', () => {
    const parsed = parseClaudeStatusLineBody(
      formBody({
        rate_limits: {
          five_hour: { used_percentage: 12, resets_at: '2026-07-20T10:00:00Z' },
          seven_day: { used_percentage: 3, resets_at: '   ' }
        }
      })
    )
    expect(parsed?.fiveHour).toEqual({ used_percentage: 12, resets_at: '2026-07-20T10:00:00Z' })
    expect(parsed?.sevenDay).toEqual({ used_percentage: 3, resets_at: undefined })
  })

  it('falls back to the OAuth-shaped utilization field so schema drift degrades gracefully', () => {
    const parsed = parseClaudeStatusLineBody(
      formBody({
        rate_limits: {
          five_hour: { utilization: 37, resets_at: 1_750_000_000 },
          seven_day: { used_percentage: 8, utilization: 99 }
        }
      })
    )
    expect(parsed?.fiveHour).toEqual({ utilization: 37, resets_at: 1_750_000_000 })
    // used_percentage wins when both are present — it is the documented statusline field.
    expect(parsed?.sevenDay).toEqual({ used_percentage: 8, resets_at: undefined })
  })

  it('returns null when rate_limits and context_window are both absent or empty', () => {
    expect(parseClaudeStatusLineBody(formBody({ rate_limits: {} }))).toBeNull()
    expect(parseClaudeStatusLineBody(formBody({ rate_limits: null }))).toBeNull()
    expect(parseClaudeStatusLineBody(formBody({ context_window: {} }))).toBeNull()
  })

  it('falls back to context_window as the session window when rate_limits is absent', () => {
    // Why: Vertex AI / internal-proxy deployments never receive rate_limits (Claude.ai-subscription
    // billing only), but Claude Code still reports local context window usage regardless of backend.
    const parsed = parseClaudeStatusLineBody(
      formBody({ context_window: { used_percentage: 8, resets_at: undefined } })
    )
    expect(parsed).toEqual({
      configDir: null,
      fiveHour: { used_percentage: 8, resets_at: undefined },
      sevenDay: null
    })
  })

  it('prefers rate_limits over context_window when both are present', () => {
    const parsed = parseClaudeStatusLineBody(
      formBody({
        rate_limits: { five_hour: { used_percentage: 23.5 } },
        context_window: { used_percentage: 91 }
      })
    )
    expect(parsed?.fiveHour).toEqual({ used_percentage: 23.5, resets_at: undefined })
  })

  it('rejects malformed bodies without throwing', () => {
    expect(parseClaudeStatusLineBody(null)).toBeNull()
    expect(parseClaudeStatusLineBody('raw string')).toBeNull()
    expect(parseClaudeStatusLineBody({ payload: 'not json' })).toBeNull()
    expect(parseClaudeStatusLineBody({ payload: '"just a string"' })).toBeNull()
    expect(
      parseClaudeStatusLineBody(
        formBody({ rate_limits: { five_hour: { used_percentage: 'NaN' } } })
      )
    ).toBeNull()
  })
})
