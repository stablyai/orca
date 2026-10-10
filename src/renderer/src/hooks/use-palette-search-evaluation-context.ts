import { useMemo } from 'react'
import {
  createPaletteSearchContext,
  type PaletteSearchContext
} from '@/lib/palette-match/palette-ranking'

/** One clock for every source participating in the current search snapshot. */
export function usePaletteSearchEvaluationContext(snapshot: unknown): PaletteSearchContext {
  return useMemo(() => {
    void snapshot
    // oxlint-disable-next-line react/purity -- Each changed snapshot starts one synchronous evaluation clock.
    return createPaletteSearchContext(Date.now())
  }, [snapshot])
}
