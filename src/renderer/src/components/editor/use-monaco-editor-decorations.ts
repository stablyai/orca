import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import type { editor } from 'monaco-editor'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import {
  clearMarkdownDocCompletionDocuments,
  setMarkdownDocCompletionDocuments
} from './monaco-markdown-doc-completions'
import type { MarkdownDocLinkDecorationController } from './monaco-markdown-doc-link-decorations'
import { buildGitConflictDecorations, hasGitConflictMarkers } from './monaco-conflict-decorations'

export type MonacoEditorDecorations = {
  markdownDocLinkDecorationsRef: MutableRefObject<MarkdownDocLinkDecorationController | null>
  conflictDecorationsRef: MutableRefObject<editor.IEditorDecorationsCollection | null>
  updateMarkdownCompletionDocuments: () => void
}

// Why: these resources are keyed to the current Monaco model, so they refresh on content/language change and tear down together on model swap or unmount.
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

  const modelKeyRef = useRef<string | null>(null)
  const markdownDocLinkDecorationsRef = useRef<MarkdownDocLinkDecorationController | null>(null)
  const conflictDecorationsRef = useRef<editor.IEditorDecorationsCollection | null>(null)

  const updateMarkdownCompletionDocuments = useCallback((): void => {
    const modelKey = editorRef.current?.getModel()?.uri.toString() ?? null
    if (modelKeyRef.current && modelKeyRef.current !== modelKey) {
      clearMarkdownDocCompletionDocuments(modelKeyRef.current)
    }
    modelKeyRef.current = modelKey
    if (!modelKey) {
      return
    }
    if (language === 'markdown' && markdownDocuments) {
      setMarkdownDocCompletionDocuments(modelKey, markdownDocuments)
    } else {
      clearMarkdownDocCompletionDocuments(modelKey)
    }
  }, [editorRef, language, markdownDocuments])

  useEffect(() => {
    markdownDocLinkDecorationsRef.current?.refresh()
  }, [content, language])

  useEffect(() => {
    const ed = mountedEditor
    if (!ed) {
      return
    }

    if (!conflictDecorationsEnabled || !hasGitConflictMarkers(content)) {
      conflictDecorationsRef.current?.clear()
      return
    }

    // Why: conflict markers are ordinary file text, so Monaco needs explicit decorations to keep unresolved blocks visible.
    const decorations = buildGitConflictDecorations(content)
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
    return () => {
      if (modelKeyRef.current) {
        clearMarkdownDocCompletionDocuments(modelKeyRef.current)
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
