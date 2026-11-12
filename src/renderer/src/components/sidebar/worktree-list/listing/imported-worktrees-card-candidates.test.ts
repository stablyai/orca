import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import type { DetectedWorktreeListResult } from '../../../../../../shared/worktree/types'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { buildImportedWorktreesCardCandidates } from './imported-worktrees-card-candidates'

function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '',
    addedAt: 0,
    kind: 'git',
    externalWorktreeVisibility: 'hide',
    ...overrides
  }
}

function detectedHidden(repoId: string): DetectedWorktreeListResult {
  return {
    repoId,
    authoritative: true,
    source: 'git',
    worktrees: [
      {
        ...makeWorktree({ id: `${repoId}::/x`, repoId, path: `/${repoId}-x` }),
        ownership: 'external',
        selectedCheckout: false,
        visible: false
      }
    ]
  }
}

describe('buildImportedWorktreesCardCandidates', () => {
  it('draws no notice for a hidden project', () => {
    const candidates = buildImportedWorktreesCardCandidates({
      repos: [repo('listed'), repo('tucked', { hiddenAt: 1 })],
      detectedWorktreesByRepo: {
        listed: detectedHidden('listed'),
        tucked: detectedHidden('tucked')
      }
    })
    expect([...candidates.keys()]).toEqual(['listed'])
  })
})
