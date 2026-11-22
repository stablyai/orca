import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getWslMoveDialog, openWslMoveDialog, setWslMoveDialog } from './wsl-move-dialog-store'

const preview = vi.fn()

beforeEach(() => {
  preview.mockResolvedValue({
    outcome: 'ready',
    repoIds: ['repo-a', 'repo-b', 'repo-c'],
    folderWorkspaceIds: ['notes'],
    blockers: []
  })
  vi.stubGlobal('window', { api: { wslMove: { preview } } })
})

afterEach(() => {
  preview.mockReset()
  vi.unstubAllGlobals()
  setWslMoveDialog({ stage: 'closed' })
})

describe('openWslMoveDialog', () => {
  it('checks exactly the projects it was opened for, not the whole distro', async () => {
    await openWslMoveDialog({
      distro: 'Ubuntu',
      only: [
        { kind: 'repo', id: 'repo-a' },
        { kind: 'folder', id: 'notes' }
      ]
    })
    const dialog = getWslMoveDialog()
    expect(dialog.stage === 'preview' ? dialog.selected : null).toEqual([
      { kind: 'repo', id: 'repo-a' },
      { kind: 'folder', id: 'notes' }
    ])
  })

  it('still takes a single project', async () => {
    await openWslMoveDialog({ distro: 'Ubuntu', only: { kind: 'repo', id: 'repo-b' } })
    const dialog = getWslMoveDialog()
    expect(dialog.stage === 'preview' ? dialog.selected : null).toEqual([
      { kind: 'repo', id: 'repo-b' }
    ])
  })
})
