import type { GitHubImageIntake } from '@/components/github/use-github-image-uploads'
import { useCallback, useEffect, useRef } from 'react'
import type { editor as monacoEditor } from 'monaco-editor'
import { createRoot } from 'react-dom/client'
import {
  invalidateCombinedEditorGeometry,
  isCombinedEditorBindingCurrent,
  onCombinedEditorUnbind
} from '../editor/combined-diff/scroll-viewport/combined-diff-editor-geometry'
import { installDiffCommentZoneMouseDownStopper } from './diff-comment-zone-mouse-events'
import { renderDiffCommentDraftZoneCard } from './diff-comment-draft-zone-card'
import {
  disposeDiffCommentDraftZone,
  snapshotDiffCommentDraft,
  type CarriedDiffCommentDraft,
  type OpenDiffCommentDraft,
  type RestoreDiffCommentDraft,
  DRAFT_ZONE_DEFAULT_HEIGHT,
  type DraftZoneEntry
} from './diff-comment-view-zone-entry'

export type DiffCommentDraft = {
  lineNumber: number
  startLine?: number
}

export type UseDiffCommentDraftZoneArgs = {
  editor: monacoEditor.ICodeEditor | null
  monacoModelIdentity?: string
  canOpenDraft?: boolean
  captureCreateComment?: boolean
  onCreateComment?: (args: {
    lineNumber: number
    startLine?: number
    body: string
  }) => Promise<boolean>
  imageUploadAddress?: GitHubImageIntake['address']
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
  captureCreateComment = false,
  onCreateComment,
  imageUploadAddress,
  draftPlaceholder,
  draftSubmitLabel,
  onAddCommentClick
}: UseDiffCommentDraftZoneArgs): DiffCommentDraftZoneHandle {
  const draftZoneRef = useRef<DraftZoneEntry | null>(null)
  // Retain the only draft copy between card teardown and replacement.
  const pendingDraftRef = useRef<CarriedDiffCommentDraft | null>(null)
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
    disposeDiffCommentDraftZone(entry, focusEditor)
  }, [])

  // Re-anchor frames and settling submits need the latest opener.
  const openDraftRef = useRef<OpenDiffCommentDraft>(() => false)

  // Restore failed submissions after teardown unless another card now owns the composer; the toast covers displaced failures.
  const restoreFailedSubmit = useCallback<RestoreDiffCommentDraft>((draft, body, createComment) => {
    if (
      unmountedRef.current ||
      draftZoneRef.current ||
      openDraftRef.current(draft, body, createComment, false)
    ) {
      return
    }
    pendingDraftRef.current = { draft, body, createComment }
  }, [])

  const openDraft = useCallback<OpenDiffCommentDraft>(
    (
      draft,
      initialBody = '',
      capturedCreateComment = onCreateCommentRef.current,
      focusOnOpen = true
    ) => {
      if (
        !editor ||
        !editor.getModel() ||
        !capturedCreateComment ||
        !canOpenDraft ||
        !isCombinedEditorBindingCurrent(editor, monacoModelIdentity)
      ) {
        return false
      }
      const combined = !isCombinedEditorBindingCurrent(editor)

      disposeDraftZone()
      editor.changeViewZones((accessor) => {
        const dom = document.createElement('div')
        dom.className = 'orca-diff-comment-inline'
        const marginDom = document.createElement('div')
        marginDom.className = 'orca-diff-comment-draft-margin'
        const disposeDomMouseDownStopper = installDiffCommentZoneMouseDownStopper(dom)
        const disposeMarginMouseDownStopper = installDiffCommentZoneMouseDownStopper(marginDom)
        const root = createRoot(dom)
        const lifetime = new AbortController()
        let didFocus = false
        const delegate: monacoEditor.IViewZone = {
          afterLineNumber: draft.lineNumber,
          heightInPx: DRAFT_ZONE_DEFAULT_HEIGHT,
          domNode: dom,
          marginDomNode: marginDom,
          suppressMouseDown: false,
          onDomNodeTop: () => {
            if (combined || lifetime.signal.aborted || didFocus) {
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
          lifetime,
          draft,
          body: initialBody,
          createComment: capturedCreateComment,
          submitting: false,
          disposeMouseDownStopper: () => {
            disposeDomMouseDownStopper()
            disposeMarginMouseDownStopper()
          }
        }
        draftZoneRef.current = entry
        renderDiffCommentDraftZoneCard(entry, {
          draftZoneRef,
          onCreateCommentRef,
          monacoModelIdentity,
          combined,
          focusOnOpen,
          captureCreateComment,
          imageUploadAddress,
          draftPlaceholder,
          draftSubmitLabel,
          disposeDraftZone,
          restoreFailedSubmit
        })
      })
      invalidateCombinedEditorGeometry(editor)
      // The re-anchor frame drops its draft only after a card actually mounts.
      return draftZoneRef.current !== null
    },
    [
      canOpenDraft,
      captureCreateComment,
      disposeDraftZone,
      imageUploadAddress,
      draftPlaceholder,
      draftSubmitLabel,
      editor,
      monacoModelIdentity,
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
      if (
        pending &&
        openDraftRef.current(pending.draft, pending.body, pending.createComment, false)
      ) {
        pendingDraftRef.current = null
      }
    })
  }, [])

  const openDraftFromArgs = useCallback(
    (args: { lineNumber: number; startLine?: number; top: number }): void => {
      if (
        !canOpenDraft ||
        (editor && !isCombinedEditorBindingCurrent(editor, monacoModelIdentity))
      ) {
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
      if (
        !openDraft(
          { lineNumber: args.lineNumber, startLine: args.startLine },
          carriedBody,
          current?.createComment ?? pending?.createComment
        )
      ) {
        pendingDraftRef.current = pending
      }
    },
    [canOpenDraft, cancelReanchorFrame, editor, monacoModelIdentity, openDraft]
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
        pendingDraftRef.current = snapshotDiffCommentDraft(current)
      }
      disposeDraftZone()
    }
    if (pendingDraftRef.current) {
      scheduleReanchor()
    }
  }, [cancelReanchorFrame, disposeDraftZone, monacoModelIdentity, scheduleReanchor])

  // Combined-diff refreshes briefly clear the editor ref; retry carried drafts when its replacement arrives.
  useEffect(() => {
    if (
      !editor ||
      !isCombinedEditorBindingCurrent(editor, monacoModelIdentity) ||
      !canOpenDraft ||
      !pendingDraftRef.current
    ) {
      return
    }
    scheduleReanchor()
    return cancelReanchorFrame
  }, [cancelReanchorFrame, canOpenDraft, editor, monacoModelIdentity, scheduleReanchor])

  useEffect(() => {
    if (!editor || !isCombinedEditorBindingCurrent(editor, monacoModelIdentity)) {
      return
    }
    return onCombinedEditorUnbind(editor, () => {
      cancelReanchorFrame()
      // Runs before the identity effect on a same-render swap, so stash here or the draft is lost.
      const current = draftZoneRef.current
      if (!unmountedRef.current && current && !current.submitting) {
        pendingDraftRef.current = snapshotDiffCommentDraft(current)
      }
      disposeDraftZone(false)
    })
  }, [cancelReanchorFrame, disposeDraftZone, editor, monacoModelIdentity])

  return { disposeDraftZone, isDraftOpen, onAddCommentClickRef }
}
