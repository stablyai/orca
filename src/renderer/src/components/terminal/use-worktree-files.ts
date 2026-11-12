import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { workspaceEditorFiles } from '@/store/slices/editor/tabs/workspace-editor-files'
export function useWorktreeFiles(
  openFiles: readonly OpenFile[],
  renderedActiveWorktreeId: string | null
): OpenFile[] {
  const tabs = useAppStore((state) =>
    renderedActiveWorktreeId ? state.unifiedTabsByWorktree[renderedActiveWorktreeId] : undefined
  )
  return useMemo(
    () => (renderedActiveWorktreeId ? workspaceEditorFiles(openFiles, tabs) : []),
    [openFiles, tabs, renderedActiveWorktreeId]
  )
}
