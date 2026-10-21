import { describe, expect, it } from 'vitest'
import {
  resolveMissingRepoProjectDialogState,
  resolveRepoBackedProjectDialogState
} from './project-dialog-state'
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
  it('keeps a repo-backed dialog when the repo still exists', () => {
    const dialog = { repoId: 'repo-1', workItem: { repoId: 'repo-1' }, label: 'Issue 1' }

    expect(resolveRepoBackedProjectDialogState(dialog, [localRow], new Set(['repo-1']))).toEqual({
      dialog,
      repo: localRow
    })
  })

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

  it('clears a repo-backed dialog when its repo is removed', () => {
    expect(
      resolveRepoBackedProjectDialogState(
        { repoId: 'repo-1', workItem: { repoId: 'repo-1' } },
        [{ ...localRow, id: 'repo-2' }],
        new Set(['repo-1'])
      ).dialog
    ).toBeNull()
  })

  it('clears a repo-backed dialog when its repo is no longer selected', () => {
    expect(
      resolveRepoBackedProjectDialogState(
        { repoId: 'repo-1', workItem: { repoId: 'repo-1' } },
        [localRow],
        new Set(['repo-2'])
      ).dialog
    ).toBeNull()
  })
})

describe('resolveMissingRepoProjectDialogState', () => {
  it('clears fallback dialogs while the slug index is rebuilding', () => {
    const slugDialog = { origin: { owner: 'stablyai', repo: 'orca' } }
    const repoNotInOrca = { owner: 'stablyai', repo: 'orca', url: null }

    expect(
      resolveMissingRepoProjectDialogState({
        slugIndexReady: false,
        slugDialog,
        repoNotInOrca,
        lookupSlug: () => [{ id: 'repo-1' }],
        selectedRepoIds: new Set(['repo-1'])
      })
    ).toEqual({ slugDialog: null, repoNotInOrca: null })
  })

  it('clears slug fallback dialogs once the repo slug resolves', () => {
    const slugDialog = { origin: { owner: 'stablyai', repo: 'orca' } }
    const repoNotInOrca = { owner: 'other', repo: 'tool', url: null }
    const result = resolveMissingRepoProjectDialogState({
      slugIndexReady: true,
      slugDialog,
      repoNotInOrca,
      lookupSlug: (slug) => (slug === 'stablyai/orca' ? [{ id: 'repo-1' }] : []),
      selectedRepoIds: new Set(['repo-1'])
    })

    expect(result.slugDialog).toBeNull()
    expect(result.repoNotInOrca).toBe(repoNotInOrca)
  })

  it('clears repo-not-in-orca dialogs once the repo slug resolves', () => {
    const slugDialog = { origin: { owner: 'other', repo: 'tool' } }
    const repoNotInOrca = { owner: 'stablyai', repo: 'orca', url: null }
    const result = resolveMissingRepoProjectDialogState({
      slugIndexReady: true,
      slugDialog,
      repoNotInOrca,
      lookupSlug: (slug) => (slug === 'stablyai/orca' ? [{ id: 'repo-1' }] : []),
      selectedRepoIds: new Set(['repo-1'])
    })

    expect(result.slugDialog).toBe(slugDialog)
    expect(result.repoNotInOrca).toBeNull()
  })

  it('clears fallback dialogs when the repo is globally known but not selected', () => {
    const slugDialog = { origin: { owner: 'stablyai', repo: 'orca' } }
    const repoNotInOrca = { owner: 'stablyai', repo: 'orca', url: null }
    const result = resolveMissingRepoProjectDialogState({
      slugIndexReady: true,
      slugDialog,
      repoNotInOrca,
      lookupSlug: () => [{ id: 'repo-2' }],
      selectedRepoIds: new Set(['repo-1'])
    })

    expect(result).toEqual({ slugDialog: null, repoNotInOrca: null })
  })

  it('keeps missing-repo fallback dialogs when there are no global matches', () => {
    const slugDialog = { origin: { owner: 'stablyai', repo: 'orca' } }
    const repoNotInOrca = { owner: 'stablyai', repo: 'orca', url: null }
    const result = resolveMissingRepoProjectDialogState({
      slugIndexReady: true,
      slugDialog,
      repoNotInOrca,
      lookupSlug: () => [],
      selectedRepoIds: new Set(['repo-1'])
    })

    expect(result).toEqual({ slugDialog, repoNotInOrca })
  })
})
