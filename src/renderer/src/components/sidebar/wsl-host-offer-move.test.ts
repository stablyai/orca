import { afterEach, describe, expect, it, vi } from 'vitest'

const toastError = vi.hoisted(() => vi.fn())
const openWslMoveDialogFor = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('../wsl-move/wsl-move-entry', () => ({ openWslMoveDialogFor }))

import { useAppStore } from '@/store'
import { moveWslHostOfferProject } from './wsl-host-offer-move'

const initialState = useAppStore.getState()

const offer = {
  path: 'W:\\home\\u\\repo',
  sharePath: '\\\\wsl.localhost\\Ubuntu\\home\\u\\repo',
  distro: 'Ubuntu',
  source: 'local_folder_picker' as const
}

afterEach(() => {
  toastError.mockReset()
  openWslMoveDialogFor.mockReset()
  useAppStore.setState(initialState, true)
})

describe('moveWslHostOfferProject', () => {
  it('opens the move for the repo the add answered with', () => {
    moveWslHostOfferProject(offer, {
      status: 'completed',
      repo: { id: 'repo-unc', path: offer.sharePath }
    })
    expect(openWslMoveDialogFor).toHaveBeenCalledWith('Ubuntu', { kind: 'repo', id: 'repo-unc' })
    expect(toastError).not.toHaveBeenCalled()
  })

  it('explains instead of opening a move when the add found the folder saved as W:', () => {
    // Registration matches by real path, so the share spelling resolves to the saved W: row.
    moveWslHostOfferProject(offer, {
      status: 'completed',
      repo: { id: 'repo-w', path: 'W:\\home\\u\\repo' }
    })
    expect(openWslMoveDialogFor).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('W:\\home\\u\\repo'))
  })

  it('falls back to the share spelling when the add names no repo', () => {
    useAppStore.setState({
      repos: [
        {
          id: 'repo-unc',
          path: offer.sharePath,
          displayName: 'repo',
          badgeColor: '#000',
          addedAt: 1
        }
      ]
    })
    moveWslHostOfferProject(offer, { status: 'skipped' })
    expect(openWslMoveDialogFor).toHaveBeenCalledWith('Ubuntu', { kind: 'repo', id: 'repo-unc' })
  })
})
