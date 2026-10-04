import { useEffect, useMemo, useState } from 'react'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { readRuntimeFileContent } from '@/runtime/runtime-file-read-client'
import { statRuntimePath } from '@/runtime/runtime-file-metadata-client'
import { settingsForRuntimeOwner } from '@/runtime/runtime-client-target'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import type { PdfAnnotationDraft, PdfSourceRange } from '@/store/slices/pdf-annotations'
import { relativePathInsideRoot } from '../../../../shared/cross-platform-path'
import { synctexPathsForPdf } from '../../../../shared/synctex-file-path'
import {
  parseSynctex,
  synctexInverseSearch,
  synctexSourceRangesInRect,
  type SynctexDocument,
  type SynctexSourceRange
} from './synctex-inverse-search'
import { synctexTextFromRead } from './synctex-read-payload'
import { resolveRichMarkdownWorktreeRoot } from './useRichMarkdownSuperscriptLinkSetup'

export type PdfSynctex = {
  /** TeX source lines behind a pending mark: its boxes, or the point for a pin. */
  resolve: (draft: Pick<PdfAnnotationDraft, 'page' | 'x' | 'y' | 'regions'>) => PdfSourceRange[]
  /** Of these source paths, the ones edited after the PDF was built (re-stats every call). */
  findStaleSources: (paths: readonly string[]) => Promise<string[]>
}

type SynctexLoad = { pdfContent: string; doc: SynctexDocument | null }

// Why: latexmk can write a source and the PDF within the same second.
const STALE_TOLERANCE_MS = 1000

function mergeByPath(ranges: PdfSourceRange[]): PdfSourceRange[] {
  const byPath = new Map<string, PdfSourceRange>()
  for (const range of ranges) {
    const existing = byPath.get(range.path)
    byPath.set(
      range.path,
      existing
        ? {
            path: range.path,
            startLine: Math.min(existing.startLine, range.startLine),
            endLine: Math.max(existing.endLine, range.endLine)
          }
        : range
    )
  }
  return [...byPath.values()]
}

/** Loads `<job>.synctex(.gz)` beside the PDF, re-reading it whenever the PDF is rebuilt. */
export function usePdfSynctex(file: OpenFile, pdfContent: string): PdfSynctex | null {
  const [loaded, setLoaded] = useState<SynctexLoad | null>(null)
  const { filePath: pdfPath, relativePath, worktreeId, runtimeEnvironmentId } = file
  const { externalSshTargetId } = file
  const worktreeRoot = useAppStore((state) => resolveRichMarkdownWorktreeRoot(state, worktreeId))

  // Why: keyed on the PDF bytes so a rebuild re-reads the SyncTeX it wrote alongside.
  useEffect(() => {
    const candidates = synctexPathsForPdf(pdfPath)
    if (candidates.length === 0 || !pdfContent) {
      return
    }
    const relativeCandidates = synctexPathsForPdf(relativePath)
    let cancelled = false
    const settings = settingsForRuntimeOwner(useAppStore.getState().settings, runtimeEnvironmentId)
    void (async () => {
      for (const [index, candidate] of candidates.entries()) {
        try {
          const text = await synctexTextFromRead(
            await readRuntimeFileContent({
              settings,
              filePath: candidate,
              relativePath: relativeCandidates[index],
              worktreeId,
              connectionId: getConnectionIdForFile(worktreeId, candidate) ?? undefined,
              expectedExternalSshTargetId: externalSshTargetId
            })
          )
          if (text) {
            if (!cancelled) {
              setLoaded({ pdfContent, doc: parseSynctex(text) })
            }
            return
          }
        } catch {
          // Missing or unreadable: try the next candidate.
        }
      }
      if (!cancelled) {
        setLoaded({ pdfContent, doc: null })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pdfPath, relativePath, worktreeId, runtimeEnvironmentId, externalSshTargetId, pdfContent])

  const doc = loaded?.pdfContent === pdfContent ? loaded.doc : null

  return useMemo(() => {
    if (!doc) {
      return null
    }
    const toReaderPath = (filePath: string): string | null => {
      const relative = worktreeRoot ? relativePathInsideRoot(worktreeRoot, filePath) : null
      // Why: running heads and page numbers come from class files, not the reader's text.
      return worktreeRoot && relative === null ? null : (relative ?? filePath)
    }
    // Why: from every input, so marks made against an earlier build can still be stale-checked.
    const absoluteByPath = new Map<string, string>()
    for (const filePath of doc.inputs.values()) {
      const path = toReaderPath(filePath)
      if (path) {
        absoluteByPath.set(path, filePath)
      }
    }
    const toSourceRanges = (ranges: SynctexSourceRange[]): PdfSourceRange[] =>
      ranges.flatMap(({ filePath, startLine, endLine }) => {
        const path = toReaderPath(filePath)
        return path ? [{ path, startLine, endLine }] : []
      })
    const fileContext = {
      settings: settingsForRuntimeOwner(useAppStore.getState().settings, runtimeEnvironmentId),
      worktreeId,
      worktreePath: worktreeRoot,
      connectionId: getConnectionIdForFile(worktreeId, pdfPath) ?? undefined,
      expectedExternalSshTargetId: externalSshTargetId
    }
    const mtimeOf = (path: string): Promise<number | null> =>
      statRuntimePath(fileContext, path).then(
        (stat) => stat.mtime,
        () => null
      )
    return {
      resolve: (draft) => {
        if (draft.regions.length > 0) {
          return mergeByPath(
            draft.regions.flatMap((region) =>
              toSourceRanges(synctexSourceRangesInRect(doc, region.page, region))
            )
          )
        }
        const location = synctexInverseSearch(doc, draft.page, draft.x, draft.y)
        return location
          ? toSourceRanges([
              { filePath: location.filePath, startLine: location.line, endLine: location.line }
            ])
          : []
      },
      findStaleSources: async (paths) => {
        const known = paths.filter((path) => absoluteByPath.has(path))
        const [pdfMtime, ...times] = await Promise.all([
          mtimeOf(pdfPath),
          ...known.map((path) => mtimeOf(absoluteByPath.get(path) ?? path))
        ])
        if (pdfMtime === null) {
          return []
        }
        return known.filter((_, index) => {
          const mtime = times[index]
          return mtime !== null && mtime > pdfMtime + STALE_TOLERANCE_MS
        })
      }
    }
  }, [doc, worktreeRoot, worktreeId, runtimeEnvironmentId, externalSshTargetId, pdfPath])
}
