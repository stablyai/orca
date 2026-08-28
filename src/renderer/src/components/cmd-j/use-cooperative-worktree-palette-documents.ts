import { useEffect, useMemo, useState } from 'react'
import {
  buildWorktreePaletteDocumentsCooperatively,
  type WorktreePaletteDocumentSources
} from '@/lib/worktree-palette-document'
import type { PaletteDocument } from '@/lib/palette-match/palette-document'
import { yieldToPalettePaint } from '@/lib/palette-cooperative-scheduler'
import type { Worktree } from '../../../../shared/worktree/types'

const EMPTY_DOCUMENTS: ReadonlyMap<string, PaletteDocument> = new Map()
const DOCUMENT_BUILD_TIME_SLICE_MS = 12

type CompletedBuild =
  | {
      request: WorktreePaletteDocumentBuildRequest
      documents: ReadonlyMap<string, PaletteDocument>
    }
  | { request: WorktreePaletteDocumentBuildRequest; error: unknown }

type WorktreePaletteDocumentBuildRequest = {
  worktrees: readonly Worktree[]
  sources: WorktreePaletteDocumentSources
}

export function useCooperativeWorktreePaletteDocuments(
  worktrees: readonly Worktree[],
  sources: WorktreePaletteDocumentSources
): { documents: ReadonlyMap<string, PaletteDocument>; pending: boolean } {
  const request = useMemo(() => ({ worktrees, sources }), [sources, worktrees])
  const [completed, setCompleted] = useState<CompletedBuild | null>(null)

  useEffect(() => {
    let current = true
    void yieldToPalettePaint()
      .then(() =>
        current
          ? buildWorktreePaletteDocumentsCooperatively(request.worktrees, request.sources, {
              shouldContinue: () => current,
              timeSliceMs: DOCUMENT_BUILD_TIME_SLICE_MS
            })
          : null
      )
      .then(
        (documents) => {
          if (current && documents) {
            setCompleted({ request, documents })
          }
        },
        (error: unknown) => {
          if (current) {
            setCompleted({ request, error })
          }
        }
      )
    return () => {
      current = false
    }
  }, [request])

  if (completed?.request !== request) {
    return { documents: EMPTY_DOCUMENTS, pending: true }
  }
  if ('error' in completed) {
    throw completed.error
  }
  return { documents: completed.documents, pending: false }
}
