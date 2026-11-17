import { useCallback, useState } from 'react'
import type { FileDiffMetadata } from '@pierre/diffs'

export function usePierreDiffLineCount(fileDiff: FileDiffMetadata) {
  const [live, setLive] = useState<{ diff: FileDiffMetadata; count: number } | null>(null)
  const rememberLineCount = useCallback(
    (count: number | undefined) => {
      if (count !== undefined) {
        setLive((previous) =>
          previous?.diff === fileDiff && previous.count === count
            ? previous
            : { diff: fileDiff, count }
        )
      }
    },
    [fileDiff]
  )
  return {
    lineCount: live?.diff === fileDiff ? live.count : fileDiff.additionLines.length,
    rememberLineCount
  }
}
