import type { AppState } from '@/store/types'
import { MODAL_DISMISSED_KEY } from '@/store/slices/ui/modal-slot-dismissal'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { NestedRepoScanResult } from '../../../../../../shared/project/groups/project-group-types'
import { enclosingGitRootOfChildFolder } from '../../../../../../shared/project/groups/nested-repo-child-folder'

const FOLDER_ADD_KEY = 'onFolderAdd'

type FolderAddListener = (added: Promise<Repo | null>) => void

type ScanForConfirmation = Pick<
  NestedRepoScanResult,
  'selectedPath' | 'selectedPathKind' | 'gitRootPath'
>

/**
 * A single add confirms folders that are not a repository root. Git registration would resolve a
 * repository's child folder to the root, so the user picks the folder or the repository (#9314).
 */
export function needsFolderConfirmation(
  scan: ScanForConfirmation | null | undefined,
  mode: 'single' | 'batch'
): boolean {
  if (!scan) {
    return false
  }
  return (
    scan.selectedPathKind === 'non_git_folder' ||
    (mode === 'single' && enclosingGitRootOfChildFolder(scan) !== null)
  )
}

/**
 * Opens "Open as Folder" for a local path; a child folder of a repository also offers the repository. Resolves to the folder its confirm adds, or null when
 * the dialog is cancelled or another modal replaces it.
 */
export function confirmNonGitFolderAdd(
  openModal: AppState['openModal'],
  folderPath: string,
  scan?: ScanForConfirmation | null
): Promise<Repo | null> {
  const enclosingGitRoot = scan ? enclosingGitRootOfChildFolder(scan) : null
  return new Promise<Repo | null>((resolve) => {
    const onFolderAdd: FolderAddListener = (added) => resolve(added)
    openModal('confirm-non-git-folder', {
      folderPath,
      ...(enclosingGitRoot ? { enclosingGitRoot } : {}),
      [FOLDER_ADD_KEY]: onFolderAdd,
      // A resolve adopted from the confirm's add wins; closing after confirm leaves it pending.
      [MODAL_DISMISSED_KEY]: () => resolve(null)
    })
  })
}

function isFolderAddListener(value: unknown): value is FolderAddListener {
  return typeof value === 'function'
}

/** Hands the confirm's add to whoever waits on it; call before closing the dialog. */
export function reportNonGitFolderAdd(
  modalData: Record<string, unknown>,
  added: Promise<Repo | null>
): void {
  const listener = modalData[FOLDER_ADD_KEY]
  if (isFolderAddListener(listener)) {
    listener(added)
  }
}
