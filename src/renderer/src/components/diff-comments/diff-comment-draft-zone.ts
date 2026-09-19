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
  onCreateComment?: (args: {
    lineNumber: number
    startLine?: number
    body: string
  }) => Promise<boolean>
  draftPlaceholder?: string
  draftSubmitLabel?: string
  draftSubmittingLabel?: string
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
  onCreateComment,
  draftPlaceholder,
  draftSubmitLabel,
  draftSubmittingLabel,
  onAddCommentClick
}: UseDiffCommentDraftZoneArgs): DiffCommentDraftZoneHandle {
  const draftZoneRef = useRef<DraftZoneEntry | null>(null)
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
    entry.editor.changeViewZones((accessor) => accessor.removeZone(entry.zoneId))
    entry.disposeMouseDownStopper()
    queueMicrotask(() => entry.root.unmount())
    if (focusEditor) {
      entry.editor.focus()
    }
  }, [])

  const openDraft = useCallback(
    (draft: DiffCommentDraft): void => {
      if (!editor || !onCreateCommentRef.current) {
        return
      }

      disposeDraftZone()
      editor.changeViewZones((accessor) => {
        const dom = document.createElement('div')
        dom.className = 'orca-diff-comment-inline'
        const marginDom = document.createElement('div')
        marginDom.className = 'orca-diff-comment-draft-margin'
        const disposeMouseDownStopper = installDiffCommentZoneMouseDownStopper(dom)
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
          delegate,
          root,
          disposeMouseDownStopper
        }
        draftZoneRef.current = entry

        renderDiffCommentDraftCard(root, draft, {
          placeholder: draftPlaceholder,
          submitLabel: draftSubmitLabel,
          submittingLabel: draftSubmittingLabel,
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
    [disposeDraftZone, draftPlaceholder, draftSubmitLabel, draftSubmittingLabel, editor]
  )
  onAddCommentClickRef.current = (args) => {
    if (onCreateCommentRef.current) {
      openDraft({ lineNumber: args.lineNumber, startLine: args.startLine })
      return
    }
    onLegacyAddCommentClickRef.current?.(args)
  }

  useEffect(() => {
    if (!editor) {
      return
    }
    return () => {
      disposeDraftZone(false)
    }
  }, [disposeDraftZone, editor, monacoModelIdentity])

  return {
    disposeDraftZone,
    onAddCommentClickRef
  }
}
