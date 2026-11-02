import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  const repos: { id: string; path: string }[] = []
  const folders: { id: string; folderPath: string }[] = []
  return { repos, folders }
})
const openDialog = vi.hoisted(() => vi.fn())
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
  })

  it('finds the added repo by its path, however its slashes are written', () => {
    state.repos = [{ id: 'other', path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\other' }]
    state.repos.push({ id: 'r1', path: '//wsl.localhost/Ubuntu/home/me/repo' })
    expect(wslHostOfferProjectRef(PATH)).toEqual({ kind: 'repo', id: 'r1' })
  })

  it('finds an added folder workspace', () => {
    state.folders = [{ id: 'f1', folderPath: PATH }]
    expect(wslHostOfferProjectRef(PATH)).toEqual({ kind: 'folder', id: 'f1' })
  })

  it('opens the move with only that project checked, never the whole distro', () => {
    state.repos = [{ id: 'r1', path: PATH }]
    moveWslHostOfferProject({ path: PATH, distro: 'Ubuntu', source: 'local_folder_picker' })
    expect(openDialog).toHaveBeenCalledWith('Ubuntu', { kind: 'repo', id: 'r1' })
  })

  it('opens nothing when the add made no project', () => {
    moveWslHostOfferProject({ path: PATH, distro: 'Ubuntu', source: 'local_folder_picker' })
    expect(openDialog).not.toHaveBeenCalled()
  })
})
