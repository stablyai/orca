import { toast } from 'sonner'
import { openFileInBrowserTab } from '@/lib/file-preview'

/** Shared by the row context menu and its keyboard shortcut. */
export function openExplorerFileInOrcaBrowser(filePath: string, worktreeId: string): void {
  const result = openFileInBrowserTab({ filePath, worktreeId })
  if (result.status === 'unsupported') {
    toast.error(result.message)
  }
}
