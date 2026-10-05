import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { BrowserAnnotationIntent } from '../../../../shared/browser-grab-types'

/** A dragged box on one page, in PDF points from that page's top-left. */
export type PdfRegion = { page: number; left: number; top: number; right: number; bottom: number }

/** A comment pinned to a point on a PDF page; in-memory like browser Design Mode annotations. */
export type PdfAnnotation = {
  id: string
  /** Owner-qualified editor file id, so two worktrees' copies of a PDF stay separate. */
  fileKey: string
  /** 1-based page; x/y in PDF points from the page's top-left. Where the badge sits. */
  page: number
  x: number
  y: number
  /** Empty for a plain click; one or more boxes when dragged (Shift+drag adds more). */
  regions: PdfRegion[]
  quote: string | null
  comment: string
  intent: BrowserAnnotationIntent
  createdAt: string
}

/** The comment being composed: where it points, before the reader writes and adds it. */
export type PdfAnnotationDraft = Pick<PdfAnnotation, 'page' | 'x' | 'y' | 'regions' | 'quote'>

/** Per-file annotate mode. Kept in the store (not the viewer) so it follows a rename with the file. */
export type PdfAnnotateSession = { armed: boolean; draft: PdfAnnotationDraft | null }

export function createPdfAnnotation(
  fileKey: string,
  draft: PdfAnnotationDraft,
  comment: string,
  intent: BrowserAnnotationIntent
): PdfAnnotation {
  return {
    id: `pdf-annotation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    fileKey,
    ...draft,
    comment,
    intent,
    createdAt: new Date().toISOString()
  }
}

type PdfAnnotationState = Pick<AppState, 'pdfAnnotationsByFileKey' | 'pdfAnnotateSessions'>

function rekeyRecord<T>(
  record: Record<string, T[]>,
  migrations: ReadonlyMap<string, string>,
  retarget: (item: T, fileKey: string) => T
): Record<string, T[]> {
  let changed = false
  const next: Record<string, T[]> = {}
  for (const [key, items] of Object.entries(record)) {
    const mapped = migrations.get(key)
    if (mapped === undefined || mapped === key) {
      next[key] = [...(next[key] ?? []), ...items]
      continue
    }
    changed = true
    next[mapped] = [...(next[mapped] ?? []), ...items.map((item) => retarget(item, mapped))]
  }
  return changed ? next : record
}

/**
 * Moves a renamed or re-owned tab's annotations and annotate session to its new file id, so
 * unsent notes, the armed mode and a half-written comment all follow the PDF.
 */
export function rekeyPdfAnnotationState(
  s: Partial<PdfAnnotationState>,
  migrations: ReadonlyMap<string, string>
): PdfAnnotationState {
  // Why: editor-only stores (tests, partial harnesses) run file-id migrations without this slice.
  const byFileKey = rekeyRecord(s.pdfAnnotationsByFileKey ?? {}, migrations, (annotation, key) => ({
    ...annotation,
    fileKey: key
  }))
  const sessions: Record<string, PdfAnnotateSession> = {}
  for (const [key, session] of Object.entries(s.pdfAnnotateSessions ?? {})) {
    sessions[migrations.get(key) ?? key] = session
  }
  return { pdfAnnotationsByFileKey: byFileKey, pdfAnnotateSessions: sessions }
}

export type PdfAnnotationsSlice = {
  pdfAnnotationsByFileKey: Record<string, PdfAnnotation[]>
  pdfAnnotateSessions: Record<string, PdfAnnotateSession>
  addPdfAnnotation: (annotation: PdfAnnotation) => void
  updatePdfAnnotation: (
    fileKey: string,
    annotationId: string,
    patch: Pick<PdfAnnotation, 'comment' | 'intent'>
  ) => void
  deletePdfAnnotation: (fileKey: string, annotationId: string) => void
  clearPdfAnnotations: (fileKey: string) => void
  /**
   * Removes only what was sent, matched by id and sent content in whatever file holds it now:
   * notes added while the picker was open, or edited after sending, stay; a rename mid-send
   * (which re-keys and clones the notes) still clears the delivered ones.
   */
  removeDeliveredPdfAnnotations: (delivered: readonly PdfAnnotation[]) => void
  setPdfAnnotateArmed: (fileKey: string, armed: boolean) => void
  setPdfAnnotationDraft: (fileKey: string, draft: PdfAnnotationDraft | null) => void
}

export const createPdfAnnotationsSlice: StateCreator<AppState, [], [], PdfAnnotationsSlice> = (
  set
) => {
  const replaceFileAnnotations = (
    state: AppState,
    fileKey: string,
    next: PdfAnnotation[]
  ): Pick<AppState, 'pdfAnnotationsByFileKey'> => {
    const byFileKey = { ...state.pdfAnnotationsByFileKey }
    if (next.length === 0) {
      delete byFileKey[fileKey]
    } else {
      byFileKey[fileKey] = next
    }
    return { pdfAnnotationsByFileKey: byFileKey }
  }
  const annotationsFor = (state: AppState, fileKey: string): PdfAnnotation[] =>
    state.pdfAnnotationsByFileKey[fileKey] ?? []
  const updateSession = (
    state: AppState,
    fileKey: string,
    patch: Partial<PdfAnnotateSession>
  ): Pick<AppState, 'pdfAnnotateSessions'> => {
    const current = state.pdfAnnotateSessions[fileKey] ?? { armed: false, draft: null }
    const next = { ...current, ...patch }
    const sessions = { ...state.pdfAnnotateSessions }
    if (!next.armed && !next.draft) {
      delete sessions[fileKey]
    } else {
      sessions[fileKey] = next
    }
    return { pdfAnnotateSessions: sessions }
  }

  return {
    pdfAnnotationsByFileKey: {},
    pdfAnnotateSessions: {},
    addPdfAnnotation: (annotation) =>
      set((s) =>
        replaceFileAnnotations(s, annotation.fileKey, [
          ...annotationsFor(s, annotation.fileKey),
          annotation
        ])
      ),
    updatePdfAnnotation: (fileKey, annotationId, patch) =>
      set((s) =>
        replaceFileAnnotations(
          s,
          fileKey,
          annotationsFor(s, fileKey).map((annotation) =>
            annotation.id === annotationId ? { ...annotation, ...patch } : annotation
          )
        )
      ),
    deletePdfAnnotation: (fileKey, annotationId) =>
      set((s) =>
        replaceFileAnnotations(
          s,
          fileKey,
          annotationsFor(s, fileKey).filter((annotation) => annotation.id !== annotationId)
        )
      ),
    clearPdfAnnotations: (fileKey) => set((s) => replaceFileAnnotations(s, fileKey, [])),
    removeDeliveredPdfAnnotations: (delivered) => {
      const sent = new Map(delivered.map((annotation) => [annotation.id, annotation]))
      const wasSent = (annotation: PdfAnnotation): boolean => {
        const snapshot = sent.get(annotation.id)
        return (
          snapshot !== undefined &&
          snapshot.comment === annotation.comment &&
          snapshot.intent === annotation.intent
        )
      }
      set((s) => {
        const byFileKey: Record<string, PdfAnnotation[]> = {}
        for (const [key, annotations] of Object.entries(s.pdfAnnotationsByFileKey)) {
          const kept = annotations.filter((annotation) => !wasSent(annotation))
          if (kept.length > 0) {
            byFileKey[key] = kept
          }
        }
        return { pdfAnnotationsByFileKey: byFileKey }
      })
    },
    // Disarming also drops the half-written comment, as leaving Design Mode does.
    setPdfAnnotateArmed: (fileKey, armed) =>
      set((s) => updateSession(s, fileKey, armed ? { armed } : { armed, draft: null })),
    setPdfAnnotationDraft: (fileKey, draft) => set((s) => updateSession(s, fileKey, { draft }))
  }
}
