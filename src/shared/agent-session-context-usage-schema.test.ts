import { describe, expect, it } from 'vitest'
import {
  MAX_CONTEXT_CATEGORIES,
  MAX_CONTEXT_CATEGORY_NAME_CHARS,
  MAX_CONTEXT_MODEL_ID_CHARS
} from './agent-session-context-usage'
import {
  AgentSessionContextUsageSchema,
  isAdmissibleAgentSessionContextUsage
} from './agent-session-context-usage-schema'

const report = {
  kind: 'report',
  model: 'model-1',
  usedTokens: 100,
  windowTokens: 1_000,
  percentage: 10,
  categories: [{ name: 'messages', tokens: 100 }],
  capturedAt: 1
} as const

describe('context usage admission', () => {
  it.each([
    {},
    { window: { tokens: 1_000, capturedAt: 1 } },
    { used: { kind: 'unknown', capturedAt: 1 } },
    {
      used: {
        kind: 'estimate',
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0
        },
        capturedAt: 1
      }
    },
    { used: report, future: { retained: true } },
    {
      used: {
        ...report,
        model: 'x'.repeat(MAX_CONTEXT_MODEL_ID_CHARS),
        categories: Array.from({ length: MAX_CONTEXT_CATEGORIES }, () => ({
          name: 'x'.repeat(MAX_CONTEXT_CATEGORY_NAME_CHARS),
          tokens: 0
        }))
      }
    }
  ])('accepts canonical facts and leaves inputs untouched (%j)', (value) => {
    const original = structuredClone(value)
    expect(isAdmissibleAgentSessionContextUsage(value)).toBe(true)
    expect(AgentSessionContextUsageSchema.safeParse(value).success).toBe(true)
    expect(value).toEqual(original)
  })

  it.each([
    null,
    { window: { tokens: 0, capturedAt: 1 } },
    { used: { kind: 'future', capturedAt: 1 } },
    { used: { ...report, usedTokens: -1 } },
    { used: { ...report, percentage: Number.NaN } },
    { used: { ...report, capturedAt: Number.POSITIVE_INFINITY } },
    { used: { ...report, model: 'x'.repeat(MAX_CONTEXT_MODEL_ID_CHARS + 1) } },
    {
      used: { ...report, categories: Array(MAX_CONTEXT_CATEGORIES + 1).fill(report.categories[0]) }
    },
    {
      used: {
        ...report,
        categories: [{ name: 'x'.repeat(MAX_CONTEXT_CATEGORY_NAME_CHARS + 1), tokens: 0 }]
      }
    },
    { used: { ...report, categories: [{ name: 'messages', tokens: null }] } }
  ])('rejects malformed facts and bounds just like parsing (%j)', (value) => {
    expect(isAdmissibleAgentSessionContextUsage(value)).toBe(false)
    expect(AgentSessionContextUsageSchema.safeParse(value).success).toBe(false)
  })
})
