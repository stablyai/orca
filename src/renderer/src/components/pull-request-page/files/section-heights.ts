import { useCallback, useState, type SetStateAction } from 'react'

const EMPTY_SECTION_HEIGHTS: Record<number, number> = {}

export function usePRFileSectionHeights(
  entrySignature: string
): [Record<number, number>, (updater: SetStateAction<Record<number, number>>) => void] {
  const [state, setState] = useState(() => ({ entrySignature, values: EMPTY_SECTION_HEIGHTS }))
  const heights = state.entrySignature === entrySignature ? state.values : EMPTY_SECTION_HEIGHTS
  const setHeights = useCallback(
    (updater: SetStateAction<Record<number, number>>) => {
      setState((prev) => {
        const current = prev.entrySignature === entrySignature ? prev.values : EMPTY_SECTION_HEIGHTS
        return {
          entrySignature,
          values: typeof updater === 'function' ? updater(current) : updater
        }
      })
    },
    [entrySignature]
  )
  return [heights, setHeights]
}
