import type { AppState } from '@/store/types'
import { MODAL_DISMISSED_KEY } from '@/store/slices/ui/modal-slot-dismissal'
import type { Repo } from '../../../../../../shared/repository/repo-types'

const FOLDER_ADD_KEY = 'onFolderAdd'

type FolderAddListener = (added: Promise<Repo | null>) => void

/**
 * Opens "Open as Folder" for a local path. Resolves to the folder its confirm adds, or null when
 * the dialog is cancelled or another modal replaces it.
 */
export function confirmNonGitFolderAdd(
  openModal: AppState['openModal'],
  folderPath: string
): Promise<Repo | null> {
  return new Promise<Repo | null>((resolve) => {
    const onFolderAdd: FolderAddListener = (added) => resolve(added)
    openModal('confirm-non-git-folder', {
      folderPath,
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
