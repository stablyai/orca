import { describe, expect, it } from 'vitest'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'

describe('per-worktree notification mute', () => {
  it('stores only mute opt-ins when toggling', () => {
    const store = createUIStore()

    store.getState().toggleWorktreeNotificationsMuted('repo-1::/repo')
    store.getState().toggleWorktreeNotificationsMuted('repo-2::/repo')
    store.getState().toggleWorktreeNotificationsMuted('repo-2::/repo')

    expect(store.getState().notificationsMutedByWorktree).toEqual({
      'repo-1::/repo': true
    })
  })

  it('hydrates persisted mutes and drops invalid entries', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        notificationsMutedByWorktree: {
          'repo-1::/repo': true,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exercises a corrupt persisted value.
          'repo-2::/repo': 'nope' as unknown as boolean,
          constructor: true
        }
      })
    )

    expect(store.getState().notificationsMutedByWorktree).toEqual({
      'repo-1::/repo': true
    })
  })
})
