import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'
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
  if (folder) {
    return { kind: 'folder', id: folder.id }
  }
  // A subfolder add is stored as its git toplevel; the innermost enclosing repo is the one added.
  const enclosing = state.repos
    .filter((entry) => isPathInsideOrEqual(entry.path, path))
    .sort((a, b) => b.path.length - a.path.length)[0]
  return enclosing ? { kind: 'repo', id: enclosing.id } : null
}

/** Opens the move with only the offered project checked; the user's Move is what moves it. */
export function moveWslHostOfferProject(offer: WslHostOffer): void {
  const only = wslHostOfferProjectRef(offer.path)
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
