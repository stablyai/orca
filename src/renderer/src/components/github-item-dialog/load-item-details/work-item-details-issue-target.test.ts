import { describe, expect, it, vi } from 'vitest'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import {
  getWorkItemDetailsCacheKey,
  invalidateWorkItemDetailsCacheByMatch,
  touchWorkItemDetailsCache,
  workItemDetailsCache
} from './work-item-details-cache'

vi.mock('@/lib/github-work-item-details-cache-events', () => ({
  onGitHubWorkItemDetailsCacheMutation: vi.fn()
}))

const keyArgs = {
  repoId: 'repo-1',
  repoPath: '/home/fixture/widgets',
  type: 'issue' as const,
  number: 12,
  issueSourcePreference: 'origin'
}
const ORIGIN = { owner: 'fork-owner', repo: 'widgets', host: 'github.com' }
const UPSTREAM = { owner: 'upstream-owner', repo: 'widgets', host: 'github.com' }
const LOCAL_SOURCE: TaskSourceContext = {
  kind: 'task-source',
  provider: 'github',
  projectId: 'project-1',
  hostId: 'local',
  repoId: 'repo-1'
}

describe('issue detail cache repository identity', () => {
  it('separates equal issue numbers across origin and upstream', () => {
    expect(getWorkItemDetailsCacheKey({ ...keyArgs, ownerRepo: ORIGIN })).not.toBe(
      getWorkItemDetailsCacheKey({ ...keyArgs, ownerRepo: UPSTREAM })
    )
  })

  it.each([undefined, LOCAL_SOURCE])(
    'keeps a local opened issue key stable when another window changes the selector: %j',
    (sourceContext) => {
      expect(getWorkItemDetailsCacheKey({ ...keyArgs, ownerRepo: ORIGIN, sourceContext })).toBe(
        getWorkItemDetailsCacheKey({
          ...keyArgs,
          issueSourcePreference: 'upstream',
          ownerRepo: ORIGIN,
          sourceContext
        })
      )
    }
  )

  it('keeps RPC detail caches scoped to the preference used by their existing lookup', () => {
    const sourceContext: TaskSourceContext = {
      kind: 'task-source',
      provider: 'github',
      projectId: 'project-1',
      hostId: 'runtime:env-1',
      repoId: 'runtime-repo'
    }
    const args = { ...keyArgs, ownerRepo: ORIGIN, sourceContext }

    expect(getWorkItemDetailsCacheKey(args)).not.toBe(
      getWorkItemDetailsCacheKey({ ...args, issueSourcePreference: 'upstream' })
    )
    expect(getWorkItemDetailsCacheKey(args)).toBe(
      getWorkItemDetailsCacheKey({ ...args, ownerRepo: null })
    )
  })

  it('invalidates both repository variants after a mutation', () => {
    const originKey = getWorkItemDetailsCacheKey({ ...keyArgs, ownerRepo: ORIGIN })
    const upstreamKey = getWorkItemDetailsCacheKey({ ...keyArgs, ownerRepo: UPSTREAM })
    touchWorkItemDetailsCache(originKey, { details: null, fetchedAt: 0 })
    touchWorkItemDetailsCache(upstreamKey, { details: null, fetchedAt: 0 })

    invalidateWorkItemDetailsCacheByMatch(keyArgs)

    expect(workItemDetailsCache.has(originKey)).toBe(false)
    expect(workItemDetailsCache.has(upstreamKey)).toBe(false)
  })
})
