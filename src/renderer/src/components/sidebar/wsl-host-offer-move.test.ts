import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  const repos: { id: string; path: string }[] = []
  const folders: { id: string; folderPath: string }[] = []
  return { repos, folders }
})
const openDialog = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('@/store/workspace-record-selectors', () => ({
  selectFolderWorkspaces: (current: typeof state) => current.folders
}))
vi.mock('../wsl-move/wsl-move-entry', () => ({ openWslMoveDialogFor: openDialog }))

import { moveWslHostOfferProject, wslHostOfferProjectRef } from './wsl-host-offer-move'

const PATH = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'

describe("the offer's move of the project it added (B3)", () => {
  beforeEach(() => {
    state.repos = []
    state.folders = []
    openDialog.mockReset()
    toastError.mockReset()
  })

  it('finds the added repo by its path, however its slashes are written', () => {
    state.repos = [{ id: 'other', path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\other' }]
    state.repos.push({ id: 'r1', path: '//wsl.localhost/Ubuntu/home/me/repo' })
    expect(wslHostOfferProjectRef(PATH)).toEqual({ kind: 'repo', id: 'r1' })
  })

  it('finds the innermost stored repo that contains an added subfolder', () => {
    state.repos = [
      { id: 'outer', path: '\\\\wsl.localhost\\Ubuntu\\home\\me' },
      { id: 'r1', path: PATH },
      { id: 'sibling', path: `${PATH}-two` }
    ]
    moveWslHostOfferProject({
      path: `${PATH}\\packages\\app`,
      distro: 'Ubuntu',
      source: 'local_folder_picker'
    })
    expect(openDialog).toHaveBeenCalledWith('Ubuntu', { kind: 'repo', id: 'r1' })
    expect(toastError).not.toHaveBeenCalled()
  })

  it('does not take a sibling whose path only shares a prefix', () => {
    state.repos = [{ id: 'sibling', path: `${PATH}-two` }]
    expect(wslHostOfferProjectRef(PATH)).toBeNull()
  })

  it('says so instead of doing nothing when no stored project matches', () => {
    moveWslHostOfferProject({ path: PATH, distro: 'Ubuntu', source: 'local_folder_picker' })
    expect(openDialog).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledTimes(1)
  })
})
