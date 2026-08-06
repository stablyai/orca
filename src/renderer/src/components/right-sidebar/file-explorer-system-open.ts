import { toast } from 'sonner'
import { basename } from '@/lib/path'
import { isLocalPathOpenBlocked, showLocalPathOpenBlockedToast } from '@/lib/local-path-open-guard'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { GlobalSettings } from '../../../../shared/types'

/** Narrow store slice needed to tell whether explorer paths live on this machine. */
export type FileExplorerLocalOpenState = {
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  repos: readonly { id: string; connectionId?: string | null }[]
  worktreesByRepo: Record<string, readonly { id: string; repoId: string }[]>
  activeWorktreeId: string | null
}

export function resolveActiveWorkspaceConnectionId(
  state: FileExplorerLocalOpenState
): string | null {
  const activeWorktree = Object.values(state.worktreesByRepo)
    .flat()
    .find((worktree) => worktree.id === state.activeWorktreeId)
  if (!activeWorktree) {
    return null
  }
  return state.repos.find((repo) => repo.id === activeWorktree.repoId)?.connectionId ?? null
}

export function isFileExplorerLocalOpenBlocked(state: FileExplorerLocalOpenState): boolean {
  return isLocalPathOpenBlocked(state.settings, {
    connectionId: resolveActiveWorkspaceConnectionId(state)
  })
}

/**
 * Hands the path to the OS file association — editor, browser, image viewer.
 * Distinct from reveal, which only selects the entry in the file manager.
 */
export async function openFileExplorerPathWithSystemDefault(path: string): Promise<void> {
  if (isFileExplorerLocalOpenBlocked(useAppStore.getState())) {
    showLocalPathOpenBlockedToast()
    return
  }
  const opened = await window.api.shell.openFilePath(path)
  if (!opened) {
    toast.error(
      translate(
        'components.right.sidebar.fileExplorerSystemOpen.failed',
        "Couldn't open '{{name}}' with the system default app.",
        { name: basename(path) }
      )
    )
  }
}
