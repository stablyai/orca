import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import type * as RegistrationContext from './repo-registration-context'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from '../../worktrees-slice-test-harness'
import { makeWorktree } from '../../worktrees-slice-test-fixtures'
import {
  makeDetectedResult,
  qualifyDetectedResult
} from '../../worktrees-detected-listing-fixtures'

const visits = vi.hoisted(() => ({ scope: 'capture', capture: 0, current: 0, checks: 0 }))

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))

vi.mock('./repo-registration-context', async (importOriginal) => {
  const original = await importOriginal<typeof RegistrationContext>()
  const proxies = new WeakMap<readonly Repo[], readonly Repo[]>()
  function countedInput(repos: readonly Repo[]): readonly Repo[] {
    const cached = proxies.get(repos)
    if (cached) {
      return cached
    }
    const proxy = new Proxy(repos, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) {
          if (visits.scope === 'capture') {
            visits.capture += 1
          } else {
            visits.current += 1
          }
        }
        return Reflect.get(target, key, receiver)
      }
    })
    proxies.set(repos, proxy)
    return proxy
  }
  return {
    ...original,
    captureRepoRegistrationContext(
      ...args: Parameters<typeof original.captureRepoRegistrationContext>
    ) {
      visits.scope = 'capture'
      return original.captureRepoRegistrationContext(countedInput(args[0]), args[1], args[2])
    },
    repoRegistrationContextIsCurrent(
      ...args: Parameters<typeof original.repoRegistrationContextIsCurrent>
    ) {
      visits.scope = 'current'
      visits.checks += 1
      return original.repoRegistrationContextIsCurrent(countedInput(args[0]), args[1])
    }
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  resetWorktreeSliceModuleMemory()
  mockApi.worktrees.listDetected.mockReset()
  visits.capture = 0
  visits.current = 0
  visits.checks = 0
})

describe('registration checks in the production fleet refresh', () => {
  for (const hydrated of [true, false]) {
    it.each([25, 50, 100])(
      `${hydrated ? 'steady' : 'initial hydration'} indexes the full catalog once for %i repos`,
      async (size) => {
        const store = createTestStore()
        const repos: Repo[] = Array.from({ length: size }, (_, index) => ({
          id: `repo-${index}`,
          path: `/repo-${index}`,
          displayName: `Repo ${index}`,
          badgeColor: '#000',
          addedAt: index,
          executionHostId: 'local'
        }))
        const rows = Object.fromEntries(
          repos.map((repo) => [
            repo.id,
            [makeWorktree({ id: `${repo.id}::${repo.path}`, repoId: repo.id, path: repo.path })]
          ])
        )
        store.setState({
          repos,
          worktreesByRepo: rows,
          detectedWorktreesByRepo: Object.fromEntries(
            Object.entries(rows).map(([repoId, worktrees]) => [
              repoId,
              makeDetectedResult(repoId, worktrees)
            ])
          ),
          hasHydratedWorktreePurge: hydrated,
          workspaceSessionReady: true,
          hydrationSucceeded: true
        })
        mockApi.worktrees.listDetected.mockImplementation(async (request) =>
          qualifyDetectedResult(request, makeDetectedResult(request.repoId, rows[request.repoId]))
        )

        await store.getState().fetchAllWorktrees()

        expect(visits.capture).toBe(size)
        expect(visits.current).toBe(size)
        expect(visits.checks).toBe((hydrated ? 3 : 4) * size)
        expect(mockApi.worktrees.listDetected).toHaveBeenCalledTimes(size)
        expect(Object.keys(store.getState().detectedWorktreesByRepo)).toHaveLength(size)
        expect(store.getState().worktreesByRepo).toEqual(rows)
        expect(store.getState().repos).toBe(repos)
        expect(store.getState().hasHydratedWorktreePurge).toBe(true)
        expect(mockApi.runtime.call).not.toHaveBeenCalled()
        expect(mockApi.pty.kill).not.toHaveBeenCalled()
      }
    )
  }
})
