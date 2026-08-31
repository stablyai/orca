import { describe, expect, it } from 'vitest'
import type { DetectedWorktreeListResult, Worktree } from '../../../../shared/worktree/types'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  buildValidWorktreeIdsForSessionHydration,
  collectPersistedWorktreeIdsForSessionHydration
} from './degraded-repo-worktree-validity'

function worktree(id: string, repoId: string): Pick<Worktree, 'id'> {
  return { id, repoId } as Pick<Worktree, 'id'>
}

function detected(authoritative: boolean): Pick<DetectedWorktreeListResult, 'authoritative'> {
  return { authoritative }
}

describe('buildValidWorktreeIdsForSessionHydration', () => {
  it('retains canonical worktree keys when their raw id is present in the catalog', () => {
    const rawId = 'repo-a::/workspace/a'
    const canonicalKey = worktreeWorkspaceKey(rawId)

    const valid = buildValidWorktreeIdsForSessionHydration(
      {
        repos: [{ id: 'repo-a' }],
        worktreesByRepo: { 'repo-a': [worktree(rawId, 'repo-a')] }
      },
      [canonicalKey]
    )

    expect(valid).toEqual(new Set([rawId, canonicalKey]))
  })

  it('retains canonical keys while a known repo worktree scan is degraded', () => {
    const rawId = 'repo-a::/workspace/a'
    const canonicalKey = worktreeWorkspaceKey(rawId)

    const valid = buildValidWorktreeIdsForSessionHydration(
      {
        repos: [{ id: 'repo-a' }],
        worktreesByRepo: { 'repo-a': [] }
      },
      [canonicalKey]
    )

    expect(valid).toContain(canonicalKey)
  })

  it('drops canonical keys after an authoritative scan proves the worktree is gone', () => {
    const rawId = 'repo-a::/workspace/gone'
    const canonicalKey = worktreeWorkspaceKey(rawId)

    const valid = buildValidWorktreeIdsForSessionHydration(
      {
        repos: [{ id: 'repo-a' }],
        worktreesByRepo: { 'repo-a': [] },
        detectedWorktreesByRepo: { 'repo-a': detected(true) }
      },
      [canonicalKey]
    )

    expect(valid).not.toContain(canonicalKey)
  })

  it('does not treat malformed workspace prefixes as valid worktrees', () => {
    const valid = buildValidWorktreeIdsForSessionHydration(
      {
        repos: [{ id: 'repo-a' }],
        worktreesByRepo: { 'repo-a': [] }
      },
      ['worktree:', 'folder:', 'worktree:repo-a::']
    )

    expect(valid).not.toContain('worktree:')
    expect(valid).not.toContain('folder:')
    expect(valid).not.toContain('worktree:repo-a::')
  })

  it('matches a canonical key by exact raw id when duplicate owners publish the same id', () => {
    const rawId = 'repo-a::/workspace/shared'
    const canonicalKey = worktreeWorkspaceKey(rawId)

    const valid = buildValidWorktreeIdsForSessionHydration(
      {
        repos: [{ id: 'repo-a' }],
        worktreesByRepo: {
          'repo-a': [worktree(rawId, 'repo-a'), worktree(rawId, 'repo-a')]
        }
      },
      [canonicalKey]
    )

    expect(valid).toContain(rawId)
    expect(valid).toContain(canonicalKey)
    expect([...valid].filter((id) => id === canonicalKey)).toHaveLength(1)
  })
})

describe('collectPersistedWorktreeIdsForSessionHydration', () => {
  it('includes active and shutdown workspace keys without chrome entries', () => {
    const rawId = 'repo-ssh::/remote/active-only'
    const canonicalKey = worktreeWorkspaceKey(rawId)
    const session = {
      ...getDefaultWorkspaceSession(),
      activeWorkspaceKey: canonicalKey,
      activeWorktreeId: rawId,
      activeWorktreeIdsOnShutdown: [canonicalKey]
    }

    expect(collectPersistedWorktreeIdsForSessionHydration(session)).toEqual(
      new Set([canonicalKey, rawId])
    )
  })

  it('includes workspace ids carried only by browser pages or sleeping agents', () => {
    const browserWorktreeId = 'repo-browser::/remote/browser-only'
    const sleepingWorktreeId = 'repo-agent::/remote/sleeping-only'
    const session = {
      ...getDefaultWorkspaceSession(),
      browserPagesByWorkspace: {
        browser: [{ worktreeId: browserWorktreeId } as never]
      },
      sleepingAgentSessionsByPaneKey: {
        pane: { worktreeId: sleepingWorktreeId } as never
      }
    }

    const persisted = collectPersistedWorktreeIdsForSessionHydration(session)
    expect(persisted).toEqual(new Set([browserWorktreeId, sleepingWorktreeId]))
  })
})
