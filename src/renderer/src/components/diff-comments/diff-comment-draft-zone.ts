import { useCallback, useEffect, useRef } from 'react'
import type { editor as monacoEditor } from 'monaco-editor'
import { createRoot } from 'react-dom/client'
import { installDiffCommentZoneMouseDownStopper } from './diff-comment-zone-mouse-events'
import { renderDiffCommentDraftCard } from './diff-comment-zone-card'
import {
  resizeDiffCommentZone,
  DRAFT_ZONE_DEFAULT_HEIGHT,
  type DraftZoneEntry
} from './diff-comment-view-zone-entry'

export type DiffCommentDraft = {
  lineNumber: number
  startLine?: number
}

type CarriedDraft = { draft: DiffCommentDraft; body: string }

export type UseDiffCommentDraftZoneArgs = {
  editor: monacoEditor.ICodeEditor | null
  monacoModelIdentity?: string
  canOpenDraft?: boolean
  onCreateComment?: (args: {
    lineNumber: number
    startLine?: number
    body: string
  }) => Promise<boolean>
  draftPlaceholder?: string
  draftSubmitLabel?: string
  onAddCommentClick?: (args: { lineNumber: number; startLine?: number; top: number }) => void
}

export type DiffCommentDraftZoneHandle = {
  disposeDraftZone: (focusEditor?: boolean) => void
  isDraftOpen: () => boolean
  onAddCommentClickRef: React.RefObject<
    (args: { lineNumber: number; startLine?: number; top: number }) => void
  >
}

export function useDiffCommentDraftZone({
  editor,
  monacoModelIdentity,
  canOpenDraft = true,
  onCreateComment,
  draftPlaceholder,
  draftSubmitLabel,
  onAddCommentClick
}: UseDiffCommentDraftZoneArgs): DiffCommentDraftZoneHandle {
  const draftZoneRef = useRef<DraftZoneEntry | null>(null)
  // The only copy of a draft between its card being torn down and the replacement mounting.
  const pendingDraftRef = useRef<CarriedDraft | null>(null)
  const previousModelIdentityRef = useRef(monacoModelIdentity)
  const reanchorFrameRef = useRef<number | null>(null)
  const onAddCommentClickRef = useRef<
    (args: { lineNumber: number; startLine?: number; top: number }) => void
  >(() => {})

  // A save can settle after unmount; without this its retry would mount a card nobody disposes.
  const unmountedRef = useRef(false)
  const onCreateCommentRef = useRef(onCreateComment)
  const onLegacyAddCommentClickRef = useRef(onAddCommentClick)

  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
    }
  }, [])

  useEffect(() => {
    onCreateCommentRef.current = onCreateComment
    onLegacyAddCommentClickRef.current = onAddCommentClick
  }, [onAddCommentClick, onCreateComment])

  const isDraftOpen = useCallback((): boolean => draftZoneRef.current !== null, [])

  const cancelReanchorFrame = useCallback((): void => {
    if (reanchorFrameRef.current === null) {
      return
    }
    cancelAnimationFrame(reanchorFrameRef.current)
    reanchorFrameRef.current = null
  }, [])

  const disposeDraftZone = useCallback((focusEditor = false): void => {
    const entry = draftZoneRef.current
    if (!entry) {
      return
    }
    draftZoneRef.current = null
    if (entry.editor.getModel()) {
      entry.editor.changeViewZones((accessor) => accessor.removeZone(entry.zoneId))
    }
    entry.disposeMouseDownStopper()
    queueMicrotask(() => entry.root.unmount())
    if (focusEditor) {
      entry.editor.focus()
    }
  }, [])

  // Latest openDraft for callers that outlive a render: the re-anchor frame and a settling submit.
  const openDraftRef = useRef<(draft: DiffCommentDraft, initialBody?: string) => boolean>(
    () => false
  )

  // A save that failed after its card was torn down (model swap, editor refresh) brings the text
  // back for a retry; an open card means the user already moved on, and the failure toast covers it.
  const restoreFailedSubmit = useCallback((draft: DiffCommentDraft, body: string): void => {
    if (unmountedRef.current || draftZoneRef.current || openDraftRef.current(draft, body)) {
      return
    }
    pendingDraftRef.current = { draft, body }
  }, [])

  const openDraft = useCallback(
    (draft: DiffCommentDraft, initialBody = ''): boolean => {
      if (!editor || !editor.getModel() || !onCreateCommentRef.current || !canOpenDraft) {
        return false
      }

      disposeDraftZone()
      editor.changeViewZones((accessor) => {
        const dom = document.createElement('div')
        dom.className = 'orca-diff-comment-inline'
        const marginDom = document.createElement('div')
        marginDom.className = 'orca-diff-comment-draft-margin'
        const disposeDomMouseDownStopper = installDiffCommentZoneMouseDownStopper(dom)
        const disposeMarginMouseDownStopper = installDiffCommentZoneMouseDownStopper(marginDom)
        const root = createRoot(dom)
        let didFocus = false
        const delegate: monacoEditor.IViewZone = {
          afterLineNumber: draft.lineNumber,
          heightInPx: DRAFT_ZONE_DEFAULT_HEIGHT,
          domNode: dom,
          marginDomNode: marginDom,
          suppressMouseDown: false,
          onDomNodeTop: () => {
            if (didFocus) {
              return
            }
            const textarea = dom.querySelector<HTMLTextAreaElement>('textarea')
            if (!textarea) {
              return
            }
            didFocus = true
            textarea.focus()
          }
        }
        const zoneId = accessor.addZone(delegate)
        const entry: DraftZoneEntry = {
          editor,
          zoneId,
          domNode: dom,
          marginDomNode: marginDom,
          delegate,
          root,
          draft,
          body: initialBody,
          submitting: false,
          disposeMouseDownStopper: () => {
            disposeDomMouseDownStopper()
            disposeMarginMouseDownStopper()
          }
        }
        draftZoneRef.current = entry

        renderDiffCommentDraftCard(root, draft, {
          placeholder: draftPlaceholder,
          submitLabel: draftSubmitLabel,
          initialBody,
          onBodyChange: (body) => {
            if (draftZoneRef.current === entry) {
              entry.body = body
            }
          },
          resizeZone: () => {
            if (draftZoneRef.current === entry) {
              resizeDiffCommentZone(editor, entry)
            }
          },
          onCancel: () => disposeDraftZone(true),
          onSubmit: async (body) => {
            const createComment = onCreateCommentRef.current
            if (!createComment) {
              return false
            }
            entry.submitting = true
            let succeeded = false
            try {
              const result = await createComment({
                lineNumber: draft.lineNumber,
                startLine: draft.startLine,
                body
              })
              succeeded = result !== false
              return result
            } finally {
              entry.submitting = false
              if (succeeded) {
                if (draftZoneRef.current === entry) {
                  disposeDraftZone()
                }
              } else if (draftZoneRef.current !== entry) {
                restoreFailedSubmit(draft, body)
              }
            }
          }
        })
      })
      // Report what actually mounted: the re-anchor frame drops its only copy of the draft on true.
      return draftZoneRef.current !== null
    },
    [
      canOpenDraft,
      disposeDraftZone,
      draftPlaceholder,
      draftSubmitLabel,
      editor,
      restoreFailedSubmit
    ]
  )

  useEffect(() => {
    openDraftRef.current = openDraft
  }, [openDraft])

  // The stash is only cleared once a card actually mounts: the editor may still be mid-refresh
  // when the frame fires, and a later editor/identity change re-schedules from the same stash.
  const scheduleReanchor = useCallback((): void => {
    if (reanchorFrameRef.current !== null) {
      return
    }
    reanchorFrameRef.current = requestAnimationFrame(() => {
      reanchorFrameRef.current = null
      const pending = pendingDraftRef.current
      if (pending && openDraftRef.current(pending.draft, pending.body)) {
        pendingDraftRef.current = null
      }
    })
  }, [])

  const openDraftFromArgs = useCallback(
    (args: { lineNumber: number; startLine?: number; top: number }): void => {
      if (!canOpenDraft) {
        return
      }
      if (!onCreateCommentRef.current) {
        onLegacyAddCommentClickRef.current?.(args)
        return
      }
      const current = draftZoneRef.current
      const pending = pendingDraftRef.current
      // A submitting card's text is already on its way to the store; carrying it would post it twice.
      const carriedBody =
        (current && !current.submitting ? current.body : '') || pending?.body || ''
      // The user picked a new anchor, so a scheduled re-anchor must not move the card back afterwards.
      cancelReanchorFrame()
      pendingDraftRef.current = null
      if (!openDraft({ lineNumber: args.lineNumber, startLine: args.startLine }, carriedBody)) {
        pendingDraftRef.current = pending
      }
    },
    [canOpenDraft, cancelReanchorFrame, openDraft]
  )

  useEffect(() => {
    onAddCommentClickRef.current = openDraftFromArgs
  }, [openDraftFromArgs])

  useEffect(() => {
    if (previousModelIdentityRef.current === monacoModelIdentity) {
      return
    }
    previousModelIdentityRef.current = monacoModelIdentity
    cancelReanchorFrame()
    const current = draftZoneRef.current
    if (current) {
      // A save in flight owns its text: the settling submit disposes on success and re-opens on
      // failure, so carrying it here would mount a second card that could submit the same note.
      if (!current.submitting) {
        pendingDraftRef.current = { draft: current.draft, body: current.body }
      }
      disposeDraftZone()
    }
    if (pendingDraftRef.current) {
      scheduleReanchor()
    }
  }, [cancelReanchorFrame, disposeDraftZone, monacoModelIdentity, scheduleReanchor])

  // A combined-diff model refresh can briefly clear the editor ref before the replacement mounts.
  // Re-anchor any carried draft when that replacement becomes available.
  useEffect(() => {
    if (!editor || !canOpenDraft || !pendingDraftRef.current) {
      return
    }
    scheduleReanchor()
    return cancelReanchorFrame
  }, [cancelReanchorFrame, canOpenDraft, editor, scheduleReanchor])

  useEffect(() => {
    if (!editor) {
      return
    }
    return () => {
      cancelReanchorFrame()
      disposeDraftZone(false)
    }
  }, [cancelReanchorFrame, disposeDraftZone, editor])

  return {
    disposeDraftZone,
    isDraftOpen,
    onAddCommentClickRef
  }
}
