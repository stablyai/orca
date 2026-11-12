import type { GitHubImageIntake } from '@/components/github/use-github-image-uploads'
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
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
  DRAFT_ZONE_DEFAULT_HEIGHT,
  type DraftZoneEntry
} from './diff-comment-view-zone-entry'
import {
  DiffCommentFileSession,
  type DiffCommentCreate,
  type DiffCommentDraftSession
} from './diff-comment-session'
import { useLocalDiffCommentSession } from './use-local-diff-comment-session'

export type DiffCommentDraft = { lineNumber: number; startLine?: number }
export type UseDiffCommentDraftZoneArgs = {
  editor: monacoEditor.ICodeEditor | null
  monacoModelIdentity?: string
  canOpenDraft?: boolean
  captureCreateComment?: boolean
  onCreateComment?: DiffCommentCreate
  imageUploadAddress?: GitHubImageIntake['address']
  draftPlaceholder?: string
  draftSubmitLabel?: string
  onAddCommentClick?: (args: { lineNumber: number; startLine?: number; top: number }) => void
  session?: DiffCommentFileSession
}

export type DiffCommentDraftZoneHandle = {
  isDraftOpen: () => boolean
  onAddCommentClickRef: React.RefObject<
    (args: { lineNumber: number; startLine?: number; top: number }) => void
  >
}

const subscribeNoDraft = (): (() => void) => () => {}

export function useDiffCommentDraftZone({
  editor,
  monacoModelIdentity,
  canOpenDraft = true,
  captureCreateComment = false,
  onCreateComment,
  imageUploadAddress,
  draftPlaceholder,
  draftSubmitLabel,
  onAddCommentClick,
  session
}: UseDiffCommentDraftZoneArgs): DiffCommentDraftZoneHandle {
  const fileSession = useLocalDiffCommentSession(() => new DiffCommentFileSession(), session)
  const draft = useSyncExternalStore(fileSession.subscribeDraft, fileSession.getDraft)
  const phase = useSyncExternalStore(
    draft?.subscribe ?? subscribeNoDraft,
    useCallback(() => draft?.getSnapshot().phase ?? null, [draft])
  )
  const draftZoneRef = useRef<DraftZoneEntry | null>(null)
  const onCreateCommentRef = useRef(onCreateComment)
  const onLegacyAddCommentClickRef = useRef(onAddCommentClick)
  const onAddCommentClickRef = useRef<
    (args: { lineNumber: number; startLine?: number; top: number }) => void
  >(() => {})
  useEffect(() => {
    onCreateCommentRef.current = onCreateComment
    onLegacyAddCommentClickRef.current = onAddCommentClick
  }, [onAddCommentClick, onCreateComment])

  const detachDraftZone = useCallback(
    (focusEditor = false, expected = draftZoneRef.current): void => {
      const entry = draftZoneRef.current
      if (entry && entry === expected) {
        draftZoneRef.current = null
        disposeDiffCommentDraftZone(entry, focusEditor)
      }
    },
    []
  )

  const cancelDraftZone = useCallback(
    (entry: DraftZoneEntry): void => {
      if (draftZoneRef.current === entry && fileSession.getDraft() === entry.session) {
        fileSession.cancelDraft(entry.session)
        detachDraftZone(true, entry)
      }
    },
    [detachDraftZone, fileSession]
  )
  const isDraftOpen = useCallback(
    (): boolean => fileSession.getDraft()?.live === true,
    [fileSession]
  )

  const mountDraft = useCallback(
    (current: DiffCommentDraftSession, focusOnOpen: boolean): void => {
      if (
        !editor ||
        !editor.getModel() ||
        !canOpenDraft ||
        !isCombinedEditorBindingCurrent(editor, monacoModelIdentity) ||
        fileSession.getDraft() !== current ||
        current.getSnapshot().phase !== 'editing'
      ) {
        return
      }
      if (draftZoneRef.current?.session === current && draftZoneRef.current.editor === editor) {
        return
      }
      const combined = !isCombinedEditorBindingCurrent(editor)
      detachDraftZone()
      editor.changeViewZones((accessor) => {
        const dom = document.createElement('div')
        dom.className = 'orca-diff-comment-inline'
        const marginDom = document.createElement('div')
        marginDom.className = 'orca-diff-comment-draft-margin'
        const disposeDom = installDiffCommentZoneMouseDownStopper(dom)
        const disposeMargin = installDiffCommentZoneMouseDownStopper(marginDom)
        const root = createRoot(dom)
        const lifetime = new AbortController()
        let didFocus = false
        const delegate: monacoEditor.IViewZone = {
          afterLineNumber: current.target.lineNumber,
          heightInPx: DRAFT_ZONE_DEFAULT_HEIGHT,
          domNode: dom,
          marginDomNode: marginDom,
          suppressMouseDown: false,
          onDomNodeTop: () => {
            if (combined || !focusOnOpen || lifetime.signal.aborted || didFocus) {
              return
            }
            const textarea = dom.querySelector<HTMLTextAreaElement>('textarea')
            if (textarea) {
              didFocus = true
              textarea.focus()
            }
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
          session: current,
          disposeMouseDownStopper: () => {
            disposeDom()
            disposeMargin()
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
          fileSession,
          cancelDraftZone
        })
      })
      invalidateCombinedEditorGeometry(editor)
    },
    [
      canOpenDraft,
      captureCreateComment,
      detachDraftZone,
      cancelDraftZone,
      draftPlaceholder,
      draftSubmitLabel,
      editor,
      fileSession,
      imageUploadAddress,
      monacoModelIdentity
    ]
  )

  useEffect(() => {
    if (!editor || !isCombinedEditorBindingCurrent(editor, monacoModelIdentity)) {
      return
    }
    return onCombinedEditorUnbind(editor, () => {
      const entry = draftZoneRef.current
      if (entry?.editor === editor) {
        detachDraftZone(false, entry)
      }
    })
  }, [detachDraftZone, editor, monacoModelIdentity])

  useEffect(() => {
    const entry = draftZoneRef.current
    if (entry && (entry.session !== draft || phase === 'saved' || phase === 'canceled')) {
      detachDraftZone(
        entry.session.getSnapshot().phase === 'saved' &&
          entry.domNode.contains(entry.domNode.ownerDocument.activeElement)
      )
    }
    if (!draft || phase !== 'editing') {
      return
    }
    const frame = requestAnimationFrame(() => mountDraft(draft, false))
    return () => cancelAnimationFrame(frame)
  }, [detachDraftZone, draft, editor, monacoModelIdentity, mountDraft, phase])

  useEffect(() => {
    onAddCommentClickRef.current = (args) => {
      if (
        !canOpenDraft ||
        (editor && !isCombinedEditorBindingCurrent(editor, monacoModelIdentity))
      ) {
        return
      }
      const createComment = onCreateCommentRef.current
      if (!createComment) {
        onLegacyAddCommentClickRef.current?.(args)
        return
      }
      const current = fileSession.openDraft(
        { lineNumber: args.lineNumber, startLine: args.startLine },
        captureCreateComment ? createComment : undefined
      )
      if (current) {
        mountDraft(current, true)
      }
    }
  }, [canOpenDraft, captureCreateComment, editor, fileSession, monacoModelIdentity, mountDraft])

  return { isDraftOpen, onAddCommentClickRef }
}
