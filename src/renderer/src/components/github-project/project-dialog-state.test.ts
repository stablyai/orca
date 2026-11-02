import { describe, expect, it } from 'vitest'
import { resolveRepoBackedProjectDialogState } from './project-dialog-state'

import type { Repo } from '../../../../shared/repo-types'

const localRow: Repo = {
  id: 'repo-1',
  path: '/laptop/repo',
  displayName: 'Repo',
  badgeColor: '#000',
  addedAt: 1
}
const sshRow: Repo = { ...localRow, path: '/remote/repo', connectionId: 'builder' }
const sshDialog = {
  repoId: 'repo-1',
  workItem: { repoId: 'repo-1', repoHostId: 'ssh:builder' as const }
}

describe('resolveRepoBackedProjectDialogState', () => {
  it('resolves a twin to the row the project item matched, not the other host', () => {
    const dialog = sshDialog

    expect(
      resolveRepoBackedProjectDialogState(dialog, [localRow, sshRow], new Set(['repo-1'])).repo
    ).toBe(sshRow)
    expect(
      resolveRepoBackedProjectDialogState(dialog, [sshRow, localRow], new Set(['repo-1'])).repo
    ).toBe(sshRow)
  })

  it('clears the dialog when its host row leaves, even while the twin stays', () => {
    const dialog = sshDialog
    const otherTwin: Repo = { ...localRow, executionHostId: 'runtime:env-1' }

    expect(
      resolveRepoBackedProjectDialogState(dialog, [localRow, otherTwin], new Set(['repo-1']))
    ).toEqual({ dialog: null, repo: null })
  })
})
