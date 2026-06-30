import { describe, expect, it } from 'vitest'
import {
  ARCHITECTURE_PERFORMANCE_BUDGETS,
  createArchitecturePerformanceRecorder
} from './architecture-performance'

describe('architecture performance recorder', () => {
  it('records operation duration and marks budget overruns', () => {
    const metrics: unknown[] = []
    const recorder = createArchitecturePerformanceRecorder({
      now: (() => {
        const values = [10, 10 + ARCHITECTURE_PERFORMANCE_BUDGETS.saveMs + 1]
        return () => values.shift() ?? 10
      })(),
      emit: (metric) => metrics.push(metric)
    })

    const result = recorder.measure('save', () => 'saved')

    expect(result).toBe('saved')
    expect(metrics).toEqual([
      {
        operation: 'save',
        durationMs: ARCHITECTURE_PERFORMANCE_BUDGETS.saveMs + 1,
        budgetMs: ARCHITECTURE_PERFORMANCE_BUDGETS.saveMs,
        overBudget: true
      }
    ])
  })
})
