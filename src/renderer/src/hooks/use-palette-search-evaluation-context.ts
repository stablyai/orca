import { useEffect, useState } from 'react'
import {
  createPaletteSearchContext,
  type PaletteSearchContext
} from '@/lib/palette-match/palette-ranking'

/** One clock for every source participating in the current search snapshot. */
export function usePaletteSearchEvaluationContext(snapshot: unknown): PaletteSearchContext {
  const [context, setContext] = useState(() => createPaletteSearchContext(Date.now()))
  useEffect(() => {
    void snapshot
    setContext(createPaletteSearchContext(Date.now()))
  }, [snapshot])
  return context
}
