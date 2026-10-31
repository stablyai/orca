import { useAppStore } from '@/store'
import { workspaceAdmittedFiles } from '@/store/workspace-admitted-files'
import type { OpenFile } from '@/store/slices/editor'

export function useWorktreeFiles(renderedActiveWorktreeId: string | null): OpenFile[] {
  return useAppStore((state) =>
    renderedActiveWorktreeId ? workspaceAdmittedFiles(state, renderedActiveWorktreeId) : EMPTY_FILES
  )
}
const EMPTY_FILES: OpenFile[] = []
