import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import type { editor } from 'monaco-editor'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import {
  clearMarkdownDocCompletionDocuments,
  setMarkdownDocCompletionDocuments
} from './monaco-markdown-doc-completions'
import type { MarkdownDocLinkDecorationController } from './monaco-markdown-doc-link-decorations'
import { buildGitConflictDecorations } from './monaco-conflict-decorations'

export type MonacoEditorDecorations = {
  markdownDocLinkDecorationsRef: MutableRefObject<MarkdownDocLinkDecorationController | null>
  conflictDecorationsRef: MutableRefObject<editor.IEditorDecorationsCollection | null>
  updateMarkdownCompletionDocuments: () => void
}

// Keep model-owned decorations together so swaps and unmounts release their resources.
export function useMonacoEditorDecorations(params: {
  editorRef: MutableRefObject<editor.IStandaloneCodeEditor | null>
  mountedEditor: editor.IStandaloneCodeEditor | null
  content: string
  language: string
  markdownDocuments: MarkdownDocument[] | undefined
  conflictDecorationsEnabled: boolean
}): MonacoEditorDecorations {
  const {
    editorRef,
    mountedEditor,
    content,
    language,
    markdownDocuments,
    conflictDecorationsEnabled
  } = params

  const completionOwnerRef = useRef(Symbol('markdown-completion'))
  const completionModelRef = useRef<editor.ITextModel | null>(null)
  const markdownDocLinkDecorationsRef = useRef<MarkdownDocLinkDecorationController | null>(null)
  const conflictDecorationsRef = useRef<editor.IEditorDecorationsCollection | null>(null)

  const updateMarkdownCompletionDocuments = useCallback((): void => {
    const model = editorRef.current?.getModel() ?? null
    if (completionModelRef.current && completionModelRef.current !== model) {
      clearMarkdownDocCompletionDocuments(completionModelRef.current, completionOwnerRef.current)
    }
    completionModelRef.current = model
    if (!model) {
      return
    }
    if (language === 'markdown' && markdownDocuments) {
      setMarkdownDocCompletionDocuments(model, markdownDocuments, completionOwnerRef.current)
    } else {
      clearMarkdownDocCompletionDocuments(model, completionOwnerRef.current)
    }
  }, [editorRef, language, markdownDocuments])

  // The controller observes content edits; only language swaps lack that event and need this explicit refresh.
  useEffect(() => {
    markdownDocLinkDecorationsRef.current?.refresh()
  }, [language])

  useEffect(() => {
    const ed = mountedEditor
    if (!ed) {
      return
    }

    if (!conflictDecorationsEnabled) {
      conflictDecorationsRef.current?.clear()
      return
    }

    // Why: conflict markers are ordinary file text, so Monaco needs explicit decorations to keep unresolved blocks visible.
    const decorations = buildGitConflictDecorations(content)
    if (decorations.length === 0) {
      conflictDecorationsRef.current?.clear()
      return
    }
    if (!conflictDecorationsRef.current) {
      conflictDecorationsRef.current = ed.createDecorationsCollection(decorations)
      return
    }
    conflictDecorationsRef.current.set(decorations)
  }, [conflictDecorationsEnabled, content, mountedEditor])

  useEffect(() => {
    updateMarkdownCompletionDocuments()
  }, [updateMarkdownCompletionDocuments])

  useEffect(() => {
    const completionOwner = completionOwnerRef.current
    return () => {
      if (completionModelRef.current) {
        clearMarkdownDocCompletionDocuments(completionModelRef.current, completionOwner)
      }
      markdownDocLinkDecorationsRef.current?.dispose()
      markdownDocLinkDecorationsRef.current = null
      conflictDecorationsRef.current?.clear()
      conflictDecorationsRef.current = null
    }
  }, [])

  return {
    markdownDocLinkDecorationsRef,
    conflictDecorationsRef,
    updateMarkdownCompletionDocuments
  }
}
