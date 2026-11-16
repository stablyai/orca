import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../../shared/file-access/cross-platform-path'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { WslMoveRowRef } from '../../../../shared/wsl-move/wsl-move-driver-types'
import { openWslMoveDialogFor } from '../wsl-move/wsl-move-entry'
import type { WslHostOffer } from './wsl-host-offer-actions'

/** The local project saved at exactly `path`, in either catalog; null when none is. */
function savedProjectRef(path: string): WslMoveRowRef | null {
  const state = useAppStore.getState()
  const wanted = normalizeRuntimePathForComparison(path)
  const repo = state.repos.find(
    (entry) =>
      getRepoExecutionHostId(entry) === LOCAL_EXECUTION_HOST_ID &&
      normalizeRuntimePathForComparison(entry.path) === wanted
  )
  if (repo) {
    return { kind: 'repo', id: repo.id }
  }
  const folder = selectFolderWorkspaces(state).find(
    (entry) =>
      (entry.executionHostId ?? LOCAL_EXECUTION_HOST_ID) === LOCAL_EXECUTION_HOST_ID &&
      !entry.connectionId &&
      normalizeRuntimePathForComparison(entry.folderPath) === wanted
  )
  return folder ? { kind: 'folder', id: folder.id } : null
}

/** The local project an add of `path` lands in (just added, or already saved); else null. */
export function wslHostOfferProjectRef(path: string): WslMoveRowRef | null {
  const saved = savedProjectRef(path)
  if (saved) {
    return saved
  }
  const state = useAppStore.getState()
  // A subfolder add is stored as its git toplevel; the innermost enclosing repo is the one added.
  const enclosing = state.repos
    .filter(
      (entry) =>
        getRepoExecutionHostId(entry) === LOCAL_EXECUTION_HOST_ID &&
        isPathInsideOrEqual(entry.path, path)
    )
    .sort((a, b) => b.path.length - a.path.length)[0]
  return enclosing ? { kind: 'repo', id: enclosing.id } : null
}

/** Opens the move with only the offered project checked; the user's Move is what moves it. */
export function moveWslHostOfferProject(offer: WslHostOffer): void {
  const only = wslHostOfferProjectRef(offer.sharePath ?? offer.path)
  if (only) {
    openWslMoveDialogFor(offer.distro, only)
    return
  }
  toast.error(
    translate(
      'sidebar.wslHostOffer.projectNotFound',
      'Could not find the added project to move. Use "Move to {{distro}} host…" on the project in the sidebar.',
      { distro: offer.distro }
    )
  )
}
