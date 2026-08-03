import { describe, expect, it } from 'vitest'
import type { OrchestrationCostReport } from '../../../../shared/orchestration-cost-report'
import {
  formatOrchestrationCost,
  formatOrchestrationElapsed,
  formatOrchestrationProvider,
  formatOrchestrationTokens,
  getOrchestrationNodeDisplay,
  sumOrchestrationMetrics
} from './orchestration-cost-display'

const metrics = (
  tokens: number,
  cost: number | null,
  costStatus: 'known' | 'partial' | 'unavailable' = 'known'
) => ({
  inputTokens: tokens,
  cachedInputTokens: null,
  outputTokens: 0,
  reasoningOutputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  totalTokens: tokens,
  estimatedCostUsd: cost,
  costStatus
})

describe('orchestration cost display', () => {
  it('formats compact status values', () => {
    expect(formatOrchestrationTokens(1_250)).toBe('1.3k')
    expect(formatOrchestrationTokens(12_500_000)).toBe('13M')
    expect(formatOrchestrationCost(0.004)).toBe('<$0.01')
    expect(formatOrchestrationCost(null)).toBeNull()
    expect(formatOrchestrationElapsed(3_723_000)).toBe('1h 2m')
  })

  it('keeps partial known cost while identifying missing estimates', () => {
    expect(sumOrchestrationMetrics([metrics(100, 0.2), metrics(200, null, 'unavailable')])).toEqual(
      { tokens: 300, cost: 0.2, costStatus: 'partial' }
    )
  })

  it('uses unavailable only when no provider cost is known', () => {
    expect(sumOrchestrationMetrics([metrics(100, null, 'unavailable')])).toEqual({
      tokens: 100,
      cost: null,
      costStatus: 'unavailable'
    })
  })

  it('uses established provider brand casing', () => {
    expect(formatOrchestrationProvider('opencode')).toBe('OpenCode')
  })

  it('bounds and orders node breakdowns without looping on malformed cycles', () => {
    const task = (id: string, childIds: string[]) => ({
      id,
      parentId: null,
      childIds,
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      dispatches: [],
      elapsed: {
        direct: { milliseconds: 1_000, status: 'available' as const },
        rolledUp: { milliseconds: 1_000, status: 'available' as const }
      },
      usage: {
        direct: { attributionCertainty: 'inferred' as const, providers: [] },
        rolledUp: {
          attributionCertainty: 'inferred' as const,
          providers: [{ provider: 'codex' as const, sessionCount: 1, metrics: metrics(100, 0.1) }]
        }
      }
    })
    const report = {
      graph: { rootTaskIds: ['a'], tasks: [task('a', ['b']), task('b', ['a']), task('c', [])] }
    } as unknown as OrchestrationCostReport
    expect(getOrchestrationNodeDisplay(report, 2)).toEqual({
      nodes: [
        expect.objectContaining({ id: 'a', depth: 0 }),
        expect.objectContaining({ id: 'b', depth: 1 })
      ],
      omitted: 1
    })
  })
})
