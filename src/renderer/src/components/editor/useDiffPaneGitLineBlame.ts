import { useState } from 'react'
import type { editor } from 'monaco-editor'
import type { GitBlameContentsSource } from '../../../../shared/git-blame'
import { useAppStore } from '@/store'
import { useGitLineBlame } from './useGitLineBlame'

export function useDiffPaneGitLineBlame(args: {
  worktreeId?: string
  relativePath: string
  originalBlamePath?: string
  originalBlameRevision?: string
  originalContentsSource?: GitBlameContentsSource
  modifiedBlameRevision?: string
  modifiedContentsSource?: GitBlameContentsSource
  modifiedBufferDirty?: boolean
  widgetKeyPrefix: string
  extraEnabled?: boolean
}): {
  modifiedEditor: editor.ICodeEditor | null
  setOriginalEditor: (next: editor.ICodeEditor | null) => void
  setModifiedEditor: (next: editor.ICodeEditor | null) => void
} {
  const [originalEditor, setOriginalEditor] = useState<editor.ICodeEditor | null>(null)
  const [modifiedEditor, setModifiedEditor] = useState<editor.ICodeEditor | null>(null)
  const editorGitLineBlameEnabled = useAppStore(
    (state) => state.settings?.editorGitLineBlameEnabled
  )
  const enabled =
    Boolean(args.worktreeId) && editorGitLineBlameEnabled !== false && args.extraEnabled !== false
  const originalPath =
    args.originalBlamePath && args.originalBlamePath.length > 0
      ? args.originalBlamePath
      : args.relativePath

  useGitLineBlame({
    editor: originalEditor,
    enabled: enabled && Boolean(args.originalBlameRevision),
    worktreeId: args.worktreeId,
    relativePath: originalPath,
    revision: args.originalBlameRevision,
    contentsSource: args.originalContentsSource,
    widgetKey: `${args.widgetKeyPrefix}-original`
  })
  useGitLineBlame({
    editor: modifiedEditor,
    enabled: enabled && args.modifiedBufferDirty !== true,
    worktreeId: args.worktreeId,
    relativePath: args.relativePath,
    revision: args.modifiedBlameRevision,
    contentsSource: args.modifiedContentsSource,
    widgetKey: `${args.widgetKeyPrefix}-modified`
  })

  return { modifiedEditor, setOriginalEditor, setModifiedEditor }
}
