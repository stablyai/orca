import { useAppStore } from '@/store'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import type { WslMoveRowRef } from '../../../../shared/wsl-move/wsl-move-driver-types'
import { openWslMoveDialogFor } from '../wsl-move/wsl-move-entry'
import type { WslHostOffer } from './wsl-host-offer-actions'

/** The project the offer just added, by its path; null when the add did not create one. */
export function wslHostOfferProjectRef(path: string): WslMoveRowRef | null {
  const state = useAppStore.getState()
  const wanted = normalizeRuntimePathForComparison(path)
  const repo = state.repos.find((entry) => normalizeRuntimePathForComparison(entry.path) === wanted)
  if (repo) {
    return { kind: 'repo', id: repo.id }
  }
  const folder = selectFolderWorkspaces(state).find(
    (entry) => normalizeRuntimePathForComparison(entry.folderPath) === wanted
  )
  return folder ? { kind: 'folder', id: folder.id } : null
}

/** Opens the move with only the offered project checked; the user's Move is what moves it. */
export function moveWslHostOfferProject(offer: WslHostOffer): void {
  const only = wslHostOfferProjectRef(offer.path)
  if (only) {
    openWslMoveDialogFor(offer.distro, only)
  }
}
