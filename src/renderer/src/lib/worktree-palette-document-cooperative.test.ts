import { describe, expect, it, vi } from 'vitest'
import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../shared/worktree/types'
import {
  buildWorktreePaletteDocuments,
  buildWorktreePaletteDocumentsCooperatively
} from './worktree-palette-document'

function makeWorktree(hostId: Worktree['hostId'], displayName: string): Worktree {
  return {
    id: 'repo-1::/workspace',
    repoId: 'repo-1',
    hostId,
    path: hostId === 'local' ? '/workspace' : '/srv/workspace',
    head: 'abc123',
    branch: 'refs/heads/palette-index',
    isBare: false,
    isMainWorktree: false,
    displayName,
    comment: 'Retain complete searchable evidence.',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

const sources = { repoMap: new Map() }

describe('cooperative worktree palette documents', () => {
  it('matches the synchronous host-qualified index without yielding after the final row', async () => {
    const worktrees = [
      makeWorktree('local', 'Local workspace'),
      makeWorktree('ssh:staging', 'Remote workspace')
    ]
    const yieldBetweenSlices = vi.fn(async () => {})

    const documents = await buildWorktreePaletteDocumentsCooperatively(worktrees, sources, {
      timeSliceMs: -1,
      yieldBetweenSlices
    })

    expect(documents).toEqual(buildWorktreePaletteDocuments(worktrees, sources))
    expect([...documents!.keys()]).toEqual(worktrees.map(getWorktreeHostIdentity))
    expect(yieldBetweenSlices).toHaveBeenCalledTimes(1)
  })

  it('drops a cancelled generation before publishing partial documents', async () => {
    let current = true
    const documents = await buildWorktreePaletteDocumentsCooperatively(
      [makeWorktree('local', 'First'), makeWorktree('ssh:staging', 'Second')],
      sources,
      {
        shouldContinue: () => current,
        timeSliceMs: -1,
        yieldBetweenSlices: async () => {
          current = false
        }
      }
    )

    expect(documents).toBeNull()
  })
})
