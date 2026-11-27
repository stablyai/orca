import type React from 'react'
import { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '@/store/index'
import type { FileSearchResultOwner } from '@/lib/files/search/file-search-result-owner'
import type {
  SearchFileResult,
  SearchMatch
} from '../../../../../../shared/file-search/code-search-types'
import { cancelRevealFrame, openMatchResult } from '../content-search/search-match-open'

/** Opens a text match only when its result generation still belongs to the live draft. */
export function useOpenSearchMatch({
  resultOwner,
  resultQuery,
  liveQueryRef,
  isCurrentOwner
}: {
  resultOwner: FileSearchResultOwner | null
  resultQuery: string
  liveQueryRef: React.RefObject<string>
  isCurrentOwner: (owner: FileSearchResultOwner | null | undefined) => boolean
}): (fileResult: SearchFileResult, match: SearchMatch) => void {
  const openFile = useAppStore((s) => s.openFile)
  const setPendingEditorReveal = useAppStore((s) => s.setPendingEditorReveal)
  const revealRafRef = useRef<number | null>(null)
  const revealInnerRafRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      cancelRevealFrame(revealRafRef)
      cancelRevealFrame(revealInnerRafRef)
    },
    []
  )
  return useCallback(
    (fileResult: SearchFileResult, match: SearchMatch) => {
      if (resultQuery !== liveQueryRef.current || !isCurrentOwner(resultOwner)) {
        return
      }
      openMatchResult({
        resultOwner,
        fileResult,
        match,
        openFile,
        setPendingEditorReveal,
        revealRafRef,
        revealInnerRafRef
      })
    },
    [isCurrentOwner, liveQueryRef, openFile, resultOwner, resultQuery, setPendingEditorReveal]
  )
}
