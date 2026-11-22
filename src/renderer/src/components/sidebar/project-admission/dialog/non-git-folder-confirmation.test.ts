import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { confirmNonGitFolderAdd, reportNonGitFolderAdd } from './non-git-folder-confirmation'

const initialState = useAppStore.getState()
const PENDING = 'still pending'

afterEach(() => {
  useAppStore.setState(initialState, true)
})

function settledOrPending(promise: Promise<Repo | null>): Promise<Repo | null | typeof PENDING> {
  return Promise.race([
    promise,
    new Promise<typeof PENDING>((resolve) => setTimeout(() => resolve(PENDING), 0))
  ])
}

const folder: Repo = {
  id: 'folder-1',
  path: '\\\\wsl.localhost\\Ubuntu\\home\\u\\notes',
  displayName: 'notes',
  badgeColor: '#737373',
  addedAt: 0
}

describe('confirmNonGitFolderAdd', () => {
  it('resolves to the folder the confirm adds, though the dialog closes first', async () => {
    const added = confirmNonGitFolderAdd(useAppStore.getState().openModal, folder.path)
    let finishAdd!: (repo: Repo | null) => void
    reportNonGitFolderAdd(
      useAppStore.getState().modalData,
      new Promise<Repo | null>((resolve) => {
        finishAdd = resolve
      })
    )
    useAppStore.getState().closeModal()
    finishAdd(folder)

    await expect(added).resolves.toBe(folder)
  })

  it('resolves to null when the dialog is cancelled', async () => {
    const added = confirmNonGitFolderAdd(useAppStore.getState().openModal, folder.path)
    useAppStore.getState().closeModal()

    await expect(settledOrPending(added)).resolves.toBeNull()
  })

  it('resolves to null when another modal replaces the dialog', async () => {
    const added = confirmNonGitFolderAdd(useAppStore.getState().openModal, folder.path)
    useAppStore.getState().openModal('add-repo')

    await expect(settledOrPending(added)).resolves.toBeNull()
  })
})
