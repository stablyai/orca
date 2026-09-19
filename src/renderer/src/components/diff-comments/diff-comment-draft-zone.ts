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
  const pendingDraftRef = useRef<{ draft: DiffCommentDraft; body: string } | null>(null)
  const previousModelIdentityRef = useRef(monacoModelIdentity)
  const reanchorFrameRef = useRef<number | null>(null)
  const onAddCommentClickRef = useRef<
    (args: { lineNumber: number; startLine?: number; top: number }) => void
  >(() => {})

  const onCreateCommentRef = useRef(onCreateComment)
  const onLegacyAddCommentClickRef = useRef(onAddCommentClick)
  onCreateCommentRef.current = onCreateComment
  onLegacyAddCommentClickRef.current = onAddCommentClick

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

  const openDraft = useCallback(
    (draft: DiffCommentDraft, initialBody = ''): void => {
      if (!editor || !onCreateCommentRef.current || !canOpenDraft) {
        return
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
        const delegate: monacoEditor.IViewZone = {
          afterLineNumber: draft.lineNumber,
          heightInPx: DRAFT_ZONE_DEFAULT_HEIGHT,
          domNode: dom,
          marginDomNode: marginDom,
          suppressMouseDown: false
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
            const result = await createComment({
              lineNumber: draft.lineNumber,
              startLine: draft.startLine,
              body
            })
            if (result !== false && draftZoneRef.current === entry) {
              disposeDraftZone()
            }
            return result
          }
        })
      })
    },
    [canOpenDraft, disposeDraftZone, draftPlaceholder, draftSubmitLabel, editor]
  )
  onAddCommentClickRef.current = (args) => {
    if (!canOpenDraft) {
      return
    }
    const current = draftZoneRef.current
    const pending = pendingDraftRef.current
    const carriedBody = current?.body || pending?.body || ''
    if (onCreateCommentRef.current) {
      openDraft({ lineNumber: args.lineNumber, startLine: args.startLine }, carriedBody)
      return
    }
    onLegacyAddCommentClickRef.current?.(args)
  }

  useEffect(() => {
    if (previousModelIdentityRef.current === monacoModelIdentity) {
      return
    }
    previousModelIdentityRef.current = monacoModelIdentity
    if (reanchorFrameRef.current !== null) {
      cancelAnimationFrame(reanchorFrameRef.current)
      reanchorFrameRef.current = null
      pendingDraftRef.current = null
    }
    const current = draftZoneRef.current
    if (!current) {
      return
    }
    pendingDraftRef.current = { draft: current.draft, body: current.body }
    disposeDraftZone()
    if (!editor || !onCreateCommentRef.current || !canOpenDraft) {
      return
    }
    reanchorFrameRef.current = requestAnimationFrame(() => {
      reanchorFrameRef.current = null
      const pending = pendingDraftRef.current
      pendingDraftRef.current = null
      if (pending) {
        openDraft(pending.draft, pending.body)
      }
    })
  }, [canOpenDraft, disposeDraftZone, editor, monacoModelIdentity, openDraft])

  useEffect(() => {
    if (!editor) {
      return
    }
    return () => {
      if (reanchorFrameRef.current !== null) {
        cancelAnimationFrame(reanchorFrameRef.current)
        reanchorFrameRef.current = null
      }
      pendingDraftRef.current = null
      disposeDraftZone(false)
    }
  }, [disposeDraftZone, editor])

  return {
    disposeDraftZone,
    onAddCommentClickRef
  }
}
