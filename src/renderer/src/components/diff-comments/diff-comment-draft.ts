import type { RefObject } from 'react'
import type { editor as monacoEditor } from 'monaco-editor'

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
  isDraftOpen: () => boolean
  onAddCommentClickRef: RefObject<
    (args: { lineNumber: number; startLine?: number; top: number }) => void
  >
}
