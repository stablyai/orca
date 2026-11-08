import { useMemo } from 'react'
import {
  createPaletteSearchContext,
  type PaletteSearchContext
} from '../../../shared/palette-match/palette-ranking'
import { recomputeOn } from '@/lib/recompute-on'

/** One clock for every source participating in the current search snapshot. */
export function usePaletteSearchEvaluationContext(snapshot: unknown): PaletteSearchContext {
  return useMemo(
    () =>
      // oxlint-disable-next-line react/purity -- Each changed snapshot starts one synchronous evaluation clock.
      recomputeOn([snapshot], () => createPaletteSearchContext(Date.now())),
    [snapshot]
  )
}
