import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { pickCardStudioGallery } from './card-studio-gallery-states'

function worktree(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    repoId: 'r1',
    path: `/r/${id}`,
    head: 'abc',
    branch: `refs/heads/${id}`,
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

const repos: Repo[] = [
  { id: 'r1', path: '/r', displayName: 'r', badgeColor: '#000', addedAt: 0 },
  { id: 'ssh', path: '/s', displayName: 's', badgeColor: '#000', addedAt: 0, connectionId: 'c1' }
]

function state(worktrees: Worktree[], agents: Record<string, string> = {}) {
  const worktreesByRepo: Record<string, Worktree[]> = {}
  for (const entry of worktrees) {
    worktreesByRepo[entry.repoId] = [...(worktreesByRepo[entry.repoId] ?? []), entry]
  }
  const agentStatusByPaneKey = Object.fromEntries(
    Object.entries(agents).map(([worktreeId, agentState]) => [
      `${worktreeId}:pane`,
      { worktreeId, state: agentState, paneKey: `${worktreeId}:pane` }
    ])
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the picker reads only these three fields and each entry's worktreeId and state.
  return { worktreesByRepo, repos, agentStatusByPaneKey } as unknown as Pick<
    AppState,
    'worktreesByRepo' | 'repos' | 'agentStatusByPaneKey'
  >
}

describe('Card Studio gallery states', () => {
  it('leads with the focused workspace, then one real workspace per state, never repeating', () => {
    const picked = pickCardStudioGallery(
      state(
        [
          worktree('a', { isUnread: true }),
          worktree('b', { linkedPR: 4 }),
          worktree('c'),
          worktree('d', { repoId: 'ssh' }),
          worktree('archived', { isArchived: true, isMainWorktree: true })
        ],
        { a: 'working', c: 'blocked' }
      ),
      'a'
    )
    expect(picked.map((entry) => [entry.key, entry.worktree.id])).toEqual([
      ['focused', 'a'],
      ['blocked', 'c'],
      ['review', 'b'],
      ['ssh', 'd']
    ])
  })

  it('shows nothing when there are no workspaces', () => {
    expect(pickCardStudioGallery(state([]), null)).toEqual([])
  })
})
