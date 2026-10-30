// @vitest-environment happy-dom
import { store, fixture } from './github-task-refresh.test-fixture'

import { repo, source, key, user, returned } from './github-task-refresh-data.test-fixture'
import { expect, it } from 'vitest'
import { parseTaskQuery } from '../../../shared/task-query'
import { getTaskSourceCacheScope } from '../../../shared/task-source-context'
import { captureGitHubTaskObservation } from './github-task-observation'
import {
  createTaskPageGitHubProjectionContext,
  reapplyPendingTaskPageGitHubMutationsToCache
} from '@/components/task-page/github/task-page-github-work-item-mutation-pages'
import {
  resetTaskPageGitHubMutationRegistryForTests,
  setTaskPageGitHubMutationQueryKey
} from '@/components/task-page/github/task-page-github-work-item-mutation-registry'
import { taskPageGitHubMutationItemId } from '@/components/task-page/github/task-page-github-work-item-mutation-keys'

it('bounds cloned-user login work for confirmed Addressed composition and completed retirement', async () => {
  const registry =
    await import('@/components/task-page/github/task-page-github-work-item-mutation-registry')
  const { observeGitHubWorkItem, gitHubTaskFamilyOrigin } =
    await import('./github-task-observation')
  const { applyTaskPageGitHubListOps } =
    await import('@/components/task-page/github/task-page-github-work-item-mutation-patches')
  const { transitionTaskPageGitHubMutationQuery } =
    await import('@/components/task-page/github/task-page-github-work-item-query-transition')
  const observations: object[] = []
  for (const [u, f] of [
    [100, 100],
    [1000, 100],
    [100, 1000],
    [1000, 1000]
  ]) {
    resetTaskPageGitHubMutationRegistryForTests()
    setTaskPageGitHubMutationQueryKey('q')
    fixture()
    const owner = captureGitHubTaskObservation(repo, source)!,
      scope = getTaskSourceCacheScope(source)
    const row = observeGitHubWorkItem(
      { ...returned.item, assignees: [], reviewRequests: [] },
      owner,
      true
    )
    const address = {
      repoId: repo.id,
      itemId: taskPageGitHubMutationItemId(row),
      itemType: 'issue' as const,
      sourceScope: scope,
      observation: owner,
      family: 'assignees' as const
    }
    for (let i = 0; i < f; i++) {
      const login = `perf-absent-${i}`,
        key = { ...address, opKey: login }
      registry.setPendingTaskPageGitHubOp({
        key,
        generation: 1,
        previous: {},
        next: {},
        startedAt: i,
        skipMeQualifiers: false,
        listOp: { family: 'assignees', kind: 'remove', logins: [login] }
      })
      expect(registry.confirmListOperation(key, 1, { kind: 'display', users: [] })).toBe(true)
    }
    const profiles = Array.from({ length: u }, (_, i) => ({
      login: `perf-user-${i}`,
      name: `Profile ${i}`,
      avatarUrl: `${i}.png`
    }))
    const full = observeGitHubWorkItem({ ...row, assignees: profiles }, owner, true)
    registry.observeExistingListBase(address, registry.listInput(full, 'assignees', owner))
    store.setState({ workItemsCache: { [key]: { data: [full], fetchedAt: 0 } } })
    expect(registry.getListEntry(address)?.protection.kind).toBe('addressed')
    let logins = 0
    const lower = String.prototype.toLowerCase
    String.prototype.toLowerCase = function (this: string) {
      const value = String(this)
      if (value.startsWith('perf-')) {
        logins++
      }
      return lower.call(this)
    }
    try {
      reapplyPendingTaskPageGitHubMutationsToCache({
        items: [full],
        patchWorkItems: store.getState().patchWorkItems,
        context: createTaskPageGitHubProjectionContext(
          [repo],
          parseTaskQuery('is:open'),
          'q',
          'alice'
        )
      })
      const composed = store.getState().workItemsCache[key].data![0]
      const lifetime = registry.getListEntry(address)!.lifetime
      const composition = logins
      logins = 0
      let retired: (typeof composed)[] = [composed]
      transitionTaskPageGitHubMutationQuery('next', store.getState(), [retired], (update) => {
        retired = update([retired])[0]!
      })
      const completed = logins
      const retirement = {
        restoration: registry.listInput(retired[0], 'assignees', owner),
        fromLifetime: lifetime
      }
      expect(store.getState().workItemsCache[key].data![0].assignees).toEqual(profiles)
      observations.push({ u, f, composition, completed })
      console.info('PERF-FACTS', JSON.stringify({ u, f, composition, completed }))
      expect(composed.assignees).toEqual(profiles)
      expect(retirement?.restoration.users).toEqual(profiles)
      expect(retirement?.restoration.kind).toBe('display')
      expect(retirement?.restoration.origin?.listLifetime).toBeUndefined()
      expect(retirement?.restoration.origin?.completeFamily).toBeUndefined()
      expect(gitHubTaskFamilyOrigin(composed, 'assignees')?.listLifetime).toBe(
        retirement?.fromLifetime
      )
      expect(registry.getListEntry(address)).toBeUndefined()
      expect.soft(composition).toBeLessThanOrEqual(30 * (u + f) + 100)
      expect.soft(completed).toBeLessThanOrEqual(30 * (u + f) + 100)
      logins = 0
      const positives = applyTaskPageGitHubListOps(
        [],
        Array.from({ length: f }, (_, i) => ({
          family: 'reviewRequests' as const,
          kind: 'add' as const,
          logins: [`perf-add-${i}`]
        }))
      )
      expect.soft(logins, 'distinct growing positives').toBeLessThanOrEqual(10 * f + 100)
      expect(positives).toHaveLength(f)
    } finally {
      String.prototype.toLowerCase = lower
    }
  }
  const a = { login: 'ALICE', name: 'Original', avatarUrl: 'a' },
    duplicate = { ...a, name: 'Duplicate' },
    b = user('bob')
  expect(
    applyTaskPageGitHubListOps(
      [a, duplicate, b],
      [{ family: 'assignees', kind: 'add', logins: ['alice'], users: [user('alice')] }]
    )
  ).toEqual([a, duplicate, b])
  expect(
    applyTaskPageGitHubListOps(
      [a, duplicate, b],
      [
        { family: 'assignees', kind: 'remove', logins: ['alice'] },
        { family: 'assignees', kind: 'add', logins: ['alice'], users: [user('Alice')] }
      ]
    )
  ).toEqual([b, user('Alice')])
  expect(
    applyTaskPageGitHubListOps(
      [a],
      [
        { family: 'reviewRequests', kind: 'remove', logins: ['ALICE'] },
        { family: 'reviewRequests', kind: 'add', logins: ['missing'], users: [user('Different')] },
        { family: 'reviewRequests', kind: 'remove', logins: ['different'] }
      ]
    )
  ).toEqual([a])
  console.info('PERF-FACTS-ALL', JSON.stringify(observations))
})

it('composes distinct confirmed positives once and lets genuine current Full empty bypass completed fallback', async () => {
  const registry =
    await import('@/components/task-page/github/task-page-github-work-item-mutation-registry')
  const { observeGitHubWorkItem } = await import('./github-task-observation')
  const { createTaskPageGitHubAuthorityProjection } =
    await import('@/components/task-page/github/task-page-github-work-item-mutation-composition')
  const { transitionTaskPageGitHubMutationQuery } =
    await import('@/components/task-page/github/task-page-github-work-item-query-transition')
  const observations: object[] = []
  for (const f of [100, 1000]) {
    resetTaskPageGitHubMutationRegistryForTests()
    setTaskPageGitHubMutationQueryKey('q')
    fixture()
    const owner = captureGitHubTaskObservation(repo, source)!,
      scope = getTaskSourceCacheScope(source)
    const fullEmpty = observeGitHubWorkItem({ ...returned.item, assignees: [] }, owner, true)
    const address = {
      repoId: repo.id,
      itemId: taskPageGitHubMutationItemId(fullEmpty),
      itemType: 'issue' as const,
      sourceScope: scope,
      observation: owner,
      family: 'assignees' as const
    }
    const profiles = Array.from({ length: f }, (_, i) => ({
      login: `perf-positive-${i}`,
      name: `Profile ${i}`,
      avatarUrl: `${i}.png`
    }))
    // Confirmation setup is outside the measured fold; its immutable facts copies are not counted as fold work.
    profiles.forEach((profile, i) => {
      const key = { ...address, opKey: profile.login }
      registry.setPendingTaskPageGitHubOp({
        key,
        generation: 1,
        previous: {},
        next: {},
        startedAt: i,
        skipMeQualifiers: false,
        listOp: { family: 'assignees', kind: 'add', logins: [profile.login], users: [profile] }
      })
      expect(registry.confirmListOperation(key, 1, { kind: 'display', users: [] })).toBe(true)
    })
    registry.observeExistingListBase(address, registry.listInput(fullEmpty, 'assignees', owner))
    let logins = 0
    const lower = String.prototype.toLowerCase
    String.prototype.toLowerCase = function (this: string) {
      const value = String(this)
      if (value.startsWith('perf-')) {
        logins++
      }
      return lower.call(this)
    }
    try {
      const composed = createTaskPageGitHubAuthorityProjection()(fullEmpty, scope, owner)
      const composition = logins
      expect(composed.assignees).toEqual(profiles)
      expect(composition).toBeLessThanOrEqual(2 * f + 10)
      store.setState({ workItemsCache: { [key]: { data: [fullEmpty], fetchedAt: 0 } } })
      logins = 0
      let pages = [composed]
      transitionTaskPageGitHubMutationQuery('next', store.getState(), [pages], (update) => {
        pages = update([pages])[0]!
      })
      expect(pages[0].assignees).toEqual([])
      expect(registry.listInput(pages[0], 'assignees', owner).kind).toBe('full')
      expect(registry.getListEntry(address)).toBeUndefined()
      expect(logins).toBe(0)
      observations.push({ f, composition, fullEmptyRetirement: logins })
    } finally {
      String.prototype.toLowerCase = lower
    }
  }
  console.info('PERF-POSITIVE-FACTS', JSON.stringify(observations))
})
