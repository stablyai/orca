// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePaletteSearchEvaluationContext } from './use-palette-search-evaluation-context'

afterEach(() => vi.restoreAllMocks())

describe('usePaletteSearchEvaluationContext', () => {
  it('captures one clock per snapshot without committing a stale ranking pass', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const evaluations: number[] = []
    const snapshot = { query: 'atlas' }
    const { result, rerender } = renderHook(
      ({ snapshot }) => {
        const context = usePaletteSearchEvaluationContext(snapshot)
        evaluations.push(context.nowMs)
        return context
      },
      { initialProps: { snapshot } }
    )
    expect(evaluations).toEqual([1_000])
    const initial = result.current

    clock.mockReturnValue(2_000)
    rerender({ snapshot })
    expect(result.current).toBe(initial)

    evaluations.length = 0
    rerender({ snapshot: { query: 'atlas notes' } })
    expect(evaluations).toEqual([2_000])
    expect(result.current).not.toBe(initial)
  })
})
