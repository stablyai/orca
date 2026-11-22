import { describe, expect, it, vi } from 'vitest'
import {
  acceptWslHostOffer,
  type WslHostOffer,
  type WslHostOfferDeps
} from './wsl-host-offer-actions'

const offer: WslHostOffer = {
  path: '\\\\wsl.localhost\\Ubuntu\\home\\u\\notes',
  distro: 'Ubuntu',
  source: 'local_folder_picker'
}

function pausedOnFolderConfirmation(): {
  deps: WslHostOfferDeps
  moveAddedProject: ReturnType<typeof vi.fn>
  settle: (added: { repo: { id: string; path: string } } | null) => void
} {
  let settle!: (added: { repo: { id: string; path: string } } | null) => void
  const projectAdded = new Promise<{ repo: { id: string; path: string } } | null>((resolve) => {
    settle = resolve
  })
  const moveAddedProject = vi.fn()
  return {
    moveAddedProject,
    settle,
    deps: {
      readWslHostsSetting: () => false,
      updateSettings: async () => {},
      addWslHost: async () => ({ ok: true, environmentId: 'env-ubuntu' }),
      addLocalPath: async () => ({ status: 'paused', projectAdded }),
      moveAddedProject
    }
  }
}

describe('acceptWslHostOffer for a plain folder', () => {
  it('moves the folder once "Open as Folder" adds it, not before', async () => {
    const { deps, moveAddedProject, settle } = pausedOnFolderConfirmation()

    await expect(acceptWslHostOffer(offer, deps)).resolves.toBeNull()
    expect(moveAddedProject).not.toHaveBeenCalled()

    settle({ repo: { id: 'folder-1', path: '\\\\wsl.localhost\\Ubuntu\\home\\u\\notes' } })
    await vi.waitFor(() => expect(moveAddedProject).toHaveBeenCalledTimes(1))
    expect(moveAddedProject).toHaveBeenCalledWith(offer, {
      repo: { id: 'folder-1', path: '\\\\wsl.localhost\\Ubuntu\\home\\u\\notes' }
    })
  })

  it('moves nothing when the user cancels "Open as Folder"', async () => {
    const { deps, moveAddedProject, settle } = pausedOnFolderConfirmation()

    await acceptWslHostOffer(offer, deps)
    settle(null)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(moveAddedProject).not.toHaveBeenCalled()
  })
})
