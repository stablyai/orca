import { useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  getExplorerBreadcrumbs,
  getExplorerDisplayRootOptions,
  getExplorerDisplayRootPath,
  isExplorerRootOutsideWorkspace,
  resolveExplorerDisplayRootChoice
} from './file-explorer-display-root'
import {
  getFileExplorerOperationOwnerFromState,
  supportsFileExplorerRootNavigation
} from './file-explorer-operation-owner'
import { useFileExplorerRootNavigation } from './use-file-explorer-root-navigation'

type ExplorerWorktree = {
  path: string
  isSparse?: boolean
  sparseDirectories?: string[]
}

export function useFileExplorerDisplayRootState(
  activeWorktreeId: string | null,
  activeWorktree: ExplorerWorktree | null,
  savedRoot?: string
) {
  const rootOptions = useMemo(() => getExplorerDisplayRootOptions(activeWorktree), [activeWorktree])
  const rootChoice = resolveExplorerDisplayRootChoice(rootOptions, savedRoot)
  const worktreePath = activeWorktree?.path ?? null
  const rootNavigationSupported = useAppStore((state) =>
    supportsFileExplorerRootNavigation(
      getFileExplorerOperationOwnerFromState(state, activeWorktreeId)
    )
  )
  const rootNavigation = useFileExplorerRootNavigation(
    activeWorktreeId,
    rootChoice,
    rootOptions,
    worktreePath
  )
  const displayRootPath = getExplorerDisplayRootPath(
    worktreePath,
    rootChoice,
    rootNavigationSupported ? rootNavigation.browsedRootPath : null
  )
  const outsideWorkspace = isExplorerRootOutsideWorkspace(worktreePath, displayRootPath)
  const navigation = displayRootPath
    ? {
        breadcrumbs: getExplorerBreadcrumbs(displayRootPath),
        outsideWorkspace,
        localOnlyDisabled: !rootNavigationSupported,
        onNavigate: rootNavigation.navigateToPath,
        onUp: rootNavigation.goUp,
        onOpenFolder: () => void rootNavigation.openFolder(),
        onBackToWorkspace: rootNavigation.backToWorkspace
      }
    : undefined
  return {
    displayRootPath,
    navigation,
    outsideWorkspace,
    rootChoice,
    rootNavigation,
    rootOptions,
    worktreePath
  }
}
