export type ArchitecturePerformanceOperation = 'save' | 'render' | 'auto-layout'

export type ArchitecturePerformanceMetric = {
  operation: ArchitecturePerformanceOperation
  durationMs: number
  budgetMs: number
  overBudget: boolean
}

export const ARCHITECTURE_PERFORMANCE_BUDGETS = {
  saveMs: 750,
  renderMs: 250,
  autoLayoutMs: 1_500
} as const

const BUDGET_BY_OPERATION: Record<ArchitecturePerformanceOperation, number> = {
  save: ARCHITECTURE_PERFORMANCE_BUDGETS.saveMs,
  render: ARCHITECTURE_PERFORMANCE_BUDGETS.renderMs,
  'auto-layout': ARCHITECTURE_PERFORMANCE_BUDGETS.autoLayoutMs
}

export function recordArchitecturePerformanceMetric(
  operation: ArchitecturePerformanceOperation,
  durationMs: number,
  emit: (metric: ArchitecturePerformanceMetric) => void = defaultArchitecturePerformanceEmitter
): void {
  const budgetMs = BUDGET_BY_OPERATION[operation]
  emit({
    operation,
    durationMs: Math.round(durationMs),
    budgetMs,
    overBudget: durationMs > budgetMs
  })
}

export function defaultArchitecturePerformanceEmitter(metric: ArchitecturePerformanceMetric): void {
  window.dispatchEvent(new CustomEvent('architecture:performance', { detail: metric }))
}

export function createArchitecturePerformanceRecorder(options?: {
  now?: () => number
  emit?: (metric: ArchitecturePerformanceMetric) => void
}) {
  const now = options?.now ?? (() => performance.now())
  const emit = options?.emit ?? defaultArchitecturePerformanceEmitter

  return {
    measure<T>(operation: ArchitecturePerformanceOperation, callback: () => T): T {
      const startedAt = now()
      try {
        return callback()
      } finally {
        recordArchitecturePerformanceMetric(operation, now() - startedAt, emit)
      }
    },

    async measureAsync<T>(
      operation: ArchitecturePerformanceOperation,
      callback: () => Promise<T>
    ): Promise<T> {
      const startedAt = now()
      try {
        return await callback()
      } finally {
        recordArchitecturePerformanceMetric(operation, now() - startedAt, emit)
      }
    }
  }
}
