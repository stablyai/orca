import { z } from 'zod'
import { expect, it } from 'vitest'
import { join } from 'node:path'
import { api } from '../../src/main/github/work-item-search-test-harness'
import { listWorkItems } from '../../src/main/github/client/list/list-work-items'
import { countWorkItems } from '../../src/main/github/client/list/count-work-items'
import {
  createTestStore,
  mockApi
} from '../../src/renderer/src/store/slices/github-slice-test-harness'

const repos = Array.from({ length: 36 }, (_, index) => ({
  repoId: `repo-${index}`,
  path: join('fixture', `repo-${index}`)
}))
function connectedStore() {
  mockApi.gh.listWorkItems.mockImplementation((...params: unknown[]) => {
    const args = z
      .object({
        repoPath: z.string(),
        limit: z.number(),
        query: z.string().optional(),
        page: z.number().optional(),
        noCache: z.boolean().optional()
      })
      .parse(params[0])
    return listWorkItems(
      args.repoPath,
      args.limit,
      args.query,
      args.page,
      undefined,
      undefined,
      args.noCache
    )
  })
  mockApi.gh.countWorkItems.mockImplementation((...params: unknown[]) => {
    const args = z.object({ repoPath: z.string(), query: z.string().optional() }).parse(params[0])
    return countWorkItems(args.repoPath, args.query)
  })
  return createTestStore()
}

it.each(['counts-first', 'lists-first'] as const)(
  'returns every repo and full totals with %s',
  async (order) => {
    const store = connectedStore()
    const lists = () =>
      store.getState().fetchWorkItemsAcrossRepos(repos, 24, 1000, '', { force: true })
    const counts = () => store.getState().countWorkItemsAcrossRepos(repos, '', 24)
    const pending =
      order === 'counts-first'
        ? { total: counts(), items: lists() }
        : { items: lists(), total: counts() }
    const [items, total] = await Promise.all([pending.items, pending.total])
    expect(items).toMatchObject({ failedCount: 0 })
    expect(items.items).toHaveLength(36 * 24)
    expect(new Set(items.items.map((item) => item.repoId)).size).toBe(36)
    expect(total).toEqual({ totalCount: 36 * 120, totalPages: 5 })
    expect(api.restSearches).toBe(0)
    expect(api.rejected).toBe(0)
    expect(api.graphqlCalls).toBeLessThanOrEqual(72)
  }
)

it('retains all repos on repeat, bypass-cache refresh and independent page jumps', async () => {
  const store = connectedStore()
  const fetch = (noCache = false) =>
    store
      .getState()
      .fetchWorkItemsAcrossRepos(repos, 24, 1000, 'is:issue is:open', { force: true, noCache })
  expect((await fetch()).items).toHaveLength(36 * 24)
  const firstCalls = api.graphqlCalls
  expect((await fetch()).items).toHaveLength(36 * 24)
  expect(api.graphqlCalls).toBe(firstCalls)
  for (let repeat = 0; repeat < 3; repeat++) {
    expect((await fetch(true)).items).toHaveLength(36 * 24)
  }
  expect(api.graphqlCalls).toBe(firstCalls + 3 * 36)
  const page3 = await store
    .getState()
    .fetchWorkItemsNextPage(repos, 24, 1000, 'is:issue is:open', 3)
  expect(page3.items).toHaveLength(36 * 24)
  expect(page3.items.every((item) => item.number <= 9952 && item.number >= 9929)).toBe(true)
  expect(page3.failedCount).toBe(0)
  expect(api.restSearches).toBe(0)
})
