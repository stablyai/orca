import { describe, expect, it } from 'vitest'
import {
  resolveMissingRepoProjectDialogState,
  resolveRepoBackedProjectDialogState
} from './project-dialog-state'

describe('resolveRepoBackedProjectDialogState', () => {
  it('keeps a repo-backed dialog when the repo still exists', () => {
    const dialog = { repoId: 'repo-1', label: 'Issue 1' }

    expect(resolveRepoBackedProjectDialogState(dialog, new Set(['repo-1']))).toBe(dialog)
  })

  it('clears a repo-backed dialog when its repo is removed', () => {
    expect(
      resolveRepoBackedProjectDialogState({ repoId: 'repo-1' }, new Set(['repo-2']))
    ).toBeNull()
  })
})

describe('resolveMissingRepoProjectDialogState', () => {
  it('waits for the slug index before closing missing-repo dialogs', () => {
    const slugDialog = { origin: { owner: 'stablyai', repo: 'orca' } }
    const repoNotInOrca = { owner: 'stablyai', repo: 'orca', url: null }

    expect(
      resolveMissingRepoProjectDialogState({
        slugIndexReady: false,
        slugDialog,
        repoNotInOrca,
        lookupSlug: () => ['repo-1']
      })
    ).toEqual({ slugDialog, repoNotInOrca })
  })

  it('clears slug fallback dialogs once the repo slug resolves', () => {
    const slugDialog = { origin: { owner: 'stablyai', repo: 'orca' } }
    const repoNotInOrca = { owner: 'other', repo: 'tool', url: null }
    const result = resolveMissingRepoProjectDialogState({
      slugIndexReady: true,
      slugDialog,
      repoNotInOrca,
      lookupSlug: (slug) => (slug === 'stablyai/orca' ? ['repo-1'] : [])
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
      lookupSlug: (slug) => (slug === 'stablyai/orca' ? ['repo-1'] : [])
    })

    expect(result.slugDialog).toBe(slugDialog)
    expect(result.repoNotInOrca).toBeNull()
  })
})
