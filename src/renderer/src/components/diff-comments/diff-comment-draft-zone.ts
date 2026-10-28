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
  // Retain the only draft copy between card teardown and replacement.
  const pendingDraftRef = useRef<CarriedDraft | null>(null)
  const previousModelIdentityRef = useRef(monacoModelIdentity)
  const reanchorFrameRef = useRef<number | null>(null)
  const onAddCommentClickRef = useRef<
    (args: { lineNumber: number; startLine?: number; top: number }) => void
  >(() => {})

  // A save settling after unmount must not restore an undisposable retry card.
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

  // Re-anchor frames and settling submits need the latest opener.
  const openDraftRef = useRef<(draft: DiffCommentDraft, initialBody?: string) => boolean>(
    () => false
  )

  // Restore failed submissions after teardown unless another card now owns the composer; the toast covers displaced failures.
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
                  // Restore Monaco focus only if this card still owns it when the save settles.
                  disposeDraftZone(entry.domNode.contains(document.activeElement))
                }
              } else if (draftZoneRef.current !== entry) {
                restoreFailedSubmit(draft, body)
              }
            }
          }
        })
      })
      // The re-anchor frame drops its draft only after a card actually mounts.
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

  // Keep the stash until mounting succeeds; the editor may still be refreshing on the first frame.
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
      // A new anchor must cancel any frame that would move the card back.
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
      // In-flight saves restore their own failures; carrying their text would allow duplicate submission.
      if (!current.submitting) {
        pendingDraftRef.current = { draft: current.draft, body: current.body }
      }
      disposeDraftZone()
    }
    if (pendingDraftRef.current) {
      scheduleReanchor()
    }
  }, [cancelReanchorFrame, disposeDraftZone, monacoModelIdentity, scheduleReanchor])

  // Combined-diff refreshes briefly clear the editor ref; retry carried drafts when its replacement arrives.
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
      // Runs before the identity effect on a same-render swap, so stash here or the draft is lost.
      const current = draftZoneRef.current
      if (!unmountedRef.current && current && !current.submitting) {
        pendingDraftRef.current = { draft: current.draft, body: current.body }
      }
      disposeDraftZone(false)
    }
  }, [cancelReanchorFrame, disposeDraftZone, editor])

  return {
    disposeDraftZone,
    isDraftOpen,
    onAddCommentClickRef
  }
}
