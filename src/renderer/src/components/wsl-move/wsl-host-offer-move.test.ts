import { afterEach, describe, expect, it, vi } from 'vitest'

const toastError = vi.hoisted(() => vi.fn())
const openWslMoveDialogFor = vi.hoisted(() => vi.fn())
const resolveWslMappedDrivePath = vi.hoisted(() =>
  vi.fn(async (_path: string): Promise<string | null> => null)
)
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('./wsl-move-entry', () => ({ openWslMoveDialogFor }))
vi.mock('../sidebar/project-admission/host-selection/wsl-mapped-drive-path', () => ({
  resolveWslMappedDrivePath
}))

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
  resolveWslMappedDrivePath.mockReset()
  resolveWslMappedDrivePath.mockResolvedValue(null)
  useAppStore.setState(initialState, true)
})

describe('moveWslHostOfferProject on a mapped drive', () => {
  it('opens the move for a project the add found saved as W:, as it is saved', async () => {
    // Registration matches by real path, so the share spelling resolves to the saved W: row.
    resolveWslMappedDrivePath.mockResolvedValue('\\\\wsl.localhost\\Ubuntu')
    moveWslHostOfferProject(offer, {
      status: 'completed',
      repo: { id: 'repo-w', path: 'W:\\home\\u\\repo' }
    })
    await vi.waitFor(() =>
      expect(openWslMoveDialogFor).toHaveBeenCalledWith('Ubuntu', { kind: 'repo', id: 'repo-w' })
    )
    expect(resolveWslMappedDrivePath).toHaveBeenCalledWith('W:\\')
    expect(toastError).not.toHaveBeenCalled()
  })

  it('explains when the saved spelling no longer maps into the offered distro', async () => {
    moveWslHostOfferProject(offer, {
      status: 'completed',
      repo: { id: 'repo-w', path: 'W:\\home\\u\\repo' }
    })
    await vi.waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringContaining('W:\\home\\u\\repo'))
    )
    expect(openWslMoveDialogFor).not.toHaveBeenCalled()
  })
})
