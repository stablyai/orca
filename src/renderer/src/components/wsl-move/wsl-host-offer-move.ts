import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../../shared/file-access/cross-platform-path'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host/execution-host'
import type { WslMoveRowRef } from '../../../../shared/wsl-move/wsl-move-driver-types'
import { openWslMoveDialogFor } from './wsl-move-entry'
import { resolveWslMappedDrivePath } from '../sidebar/project-admission/host-selection/wsl-mapped-drive-path'
import { wslMappedDrivePathToShare } from '../../../../shared/wsl-move/wsl-mapped-drive-paths'
import { wslMoveDistroOfPath } from './wsl-move-scope-rows'
import type { WslHostOffer } from '../sidebar/project-admission/host-selection/wsl-host-offer-actions'

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

/** The repo a local add answered with (new or already saved); null for any other outcome. */
function addedRepoOf(added: unknown): { id: string; path: string } | null {
  if (typeof added !== 'object' || added === null || !('repo' in added)) {
    return null
  }
  const repo = added.repo
  return typeof repo === 'object' &&
    repo !== null &&
    'id' in repo &&
    typeof repo.id === 'string' &&
    'path' in repo &&
    typeof repo.path === 'string'
    ? { id: repo.id, path: repo.path }
    : null
}

/** A project saved as `W:\…` moves as it is when its drive still maps into the offered distro. */
async function moveSavedUnderMappedDrive(
  offer: WslHostOffer,
  repo: { id: string; path: string }
): Promise<void> {
  const letter = repo.path[0]?.toUpperCase() ?? ''
  const share = /^[A-Z]$/.test(letter) ? await resolveWslMappedDrivePath(`${letter}:\\`) : null
  const sharePath = share ? wslMappedDrivePathToShare(repo.path, { letter, share }) : null
  if (sharePath && wslMoveDistroOfPath(sharePath)?.toLowerCase() === offer.distro.toLowerCase()) {
    openWslMoveDialogFor(offer.distro, { kind: 'repo', id: repo.id })
    return
  }
  toast.error(
    translate(
      'sidebar.wslHostOffer.savedUnderAnotherPath',
      "This folder is already a project here as {{path}}, which can't move to the {{distro}} host yet. Remove that project, then add the folder again to move it.",
      { path: repo.path, distro: offer.distro }
    )
  )
}

/**
 * Opens the move with only the offered project checked; the user's Move is what moves it.
 * `added` is the add's answer, which names an already-saved project the path resolved to.
 */
export function moveWslHostOfferProject(offer: WslHostOffer, added?: unknown): void {
  const repo = addedRepoOf(added)
  // The same folder was already saved under another spelling (`W:\…`).
  if (repo && wslMoveDistroOfPath(repo.path)?.toLowerCase() !== offer.distro.toLowerCase()) {
    void moveSavedUnderMappedDrive(offer, repo)
    return
  }
  const only = repo
    ? ({ kind: 'repo', id: repo.id } as const)
    : wslHostOfferProjectRef(offer.sharePath ?? offer.path)
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
