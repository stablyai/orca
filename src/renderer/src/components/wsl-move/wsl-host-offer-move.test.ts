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

describe('moveWslHostOfferProject after a nested import', () => {
  it('starts every imported repo checked, not just the first', () => {
    const parent = '\\\\wsl.localhost\\Ubuntu\\home\\u\\work'
    const imported = [
      { kind: 'repo', id: 'app-1' },
      { kind: 'repo', id: 'api-1' }
    ]
    moveWslHostOfferProject(
      { path: parent, distro: 'Ubuntu', source: 'local_folder_picker' },
      { repo: { id: 'app-1', path: `${parent}\\app` }, imported }
    )
    expect(openWslMoveDialogFor).toHaveBeenCalledWith('Ubuntu', imported)
    expect(toastError).not.toHaveBeenCalled()
  })
})
