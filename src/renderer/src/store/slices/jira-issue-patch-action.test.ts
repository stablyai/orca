import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { JiraIssue, JiraMutationResult } from '../../../../shared/jira-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import {
  bumpProviderRuntimeSessionGeneration,
  getProviderRuntimeContextKey
} from '@/lib/provider-runtime-context'
import { getJiraReadIdentity } from './jira-read-coordination'
import {
  enqueueJiraIssueMutation,
  jiraIssueRequestScope,
  subscribeJiraIssueMutation
} from '@/components/jira-issue-mutation-queue'
import { createTestStore } from './store-test-helpers'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'

createTabsSliceMockApi()

const issue: JiraIssue = {
  id: '1',
  key: 'ENG-1',
  title: 'Default title',
  siteId: 'site-1',
  url: 'https://example.atlassian.net/browse/ENG-1',
  project: { id: '1', key: 'ENG', name: 'Engineering' },
  issueType: { id: '1', name: 'Task' },
  status: { id: '1', name: 'To Do', categoryKey: 'new', categoryName: 'To Do' },
  labels: [],
  createdAt: '2026-09-01',
  updatedAt: '2026-09-01'
}

const source: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'project-1',
  hostId: 'local'
}

describe('Jira default-source issue patches', () => {
  it.each([true, false])(
    'keeps new-host edits and rollback baselines after a late old-host save (%s)',
    async (ok) => {
      const store = createTestStore()
      const contextKey = getJiraReadIdentity(store.getState().settings).contextKey
      const firstScope = jiraIssueRequestScope(issue, null, store.getState().settings)
      if (!firstScope) {
        throw new Error('Expected issue scope')
      }
      store.setState({ jiraIssueCache: { 'site-1::ENG-1': { data: issue, fetchedAt: 1 } } })
      let finishFirst: (result: JiraMutationResult) => void = () => undefined
      const firstResult = new Promise<JiraMutationResult>((resolve) => {
        finishFirst = resolve
      })
      const firstSave = enqueueJiraIssueMutation({
        scope: firstScope,
        previous: issue,
        optimistic: { title: 'Local edit' },
        update: () => firstResult,
        refresh: async () => ({ ...issue, title: 'Local edit' }),
        patchIssue: (patch) =>
          store.getState().patchJiraIssue('ENG-1', patch, { contextKey, siteId: 'site-1' })
      })
      const remoteIssue = { ...issue, title: 'Remote baseline' }
      store.setState({
        settings: { ...getDefaultSettings(''), activeRuntimeEnvironmentId: 'remote-1' },
        jiraIssueCache: { 'site-1::ENG-1': { data: remoteIssue, fetchedAt: 1 } }
      })
      const remoteContextKey = getJiraReadIdentity(store.getState().settings).contextKey
      const nextScope = jiraIssueRequestScope(remoteIssue, null, store.getState().settings)
      if (!nextScope) {
        throw new Error('Expected issue scope')
      }
      let finishNext: (result: JiraMutationResult) => void = () => undefined
      const nextResult = new Promise<JiraMutationResult>((resolve) => {
        finishNext = resolve
      })
      const nextSave = enqueueJiraIssueMutation({
        scope: nextScope,
        previous: remoteIssue,
        optimistic: { title: 'Remote edit' },
        update: () => nextResult,
        refresh: async () => remoteIssue,
        patchIssue: (patch) =>
          store
            .getState()
            .patchJiraIssue('ENG-1', patch, { contextKey: remoteContextKey, siteId: 'site-1' })
      })
      finishFirst(ok ? { ok: true } : { ok: false, error: 'Local save rejected' })
      await Promise.allSettled([firstSave])
      const afterOldSave = store.getState().jiraIssueCache['site-1::ENG-1']?.data?.title
      finishNext({ ok: false, error: 'Remote save rejected' })
      await Promise.allSettled([nextSave])

      expect(afterOldSave).toBe('Remote edit')
      expect(store.getState().jiraIssueCache['site-1::ENG-1']?.data?.title).toBe('Remote baseline')
    }
  )

  it('keeps default-source edits out of explicit source caches on every host', () => {
    const store = createTestStore()
    const cacheKeys = [
      'site-1::ENG-1',
      `${getTaskSourceCacheScope(source)}::site-1::ENG-1`,
      `${getTaskSourceCacheScope({ ...source, hostId: 'runtime:remote-1' })}::site-1::ENG-1`
    ]
    store.setState({
      jiraIssueCache: Object.fromEntries(
        cacheKeys.map((key) => [key, { data: issue, fetchedAt: Date.now() }])
      ),
      jiraSearchCache: Object.fromEntries(
        cacheKeys.map((key) => [key, { data: [issue], fetchedAt: Date.now() }])
      )
    })

    store
      .getState()
      .patchJiraIssue('ENG-1', { title: 'Edited default title' }, { siteId: 'site-1' })

    expect(cacheKeys.map((key) => store.getState().jiraIssueCache[key]?.data?.title)).toEqual([
      'Edited default title',
      'Default title',
      'Default title'
    ])
    expect(cacheKeys.map((key) => store.getState().jiraSearchCache[key]?.data?.[0]?.title)).toEqual(
      ['Edited default title', 'Default title', 'Default title']
    )
  })

  it('ignores a default-source settlement after the active execution host changes', () => {
    const store = createTestStore()
    const contextKey = getProviderRuntimeContextKey(store.getState().settings)
    store.setState({
      settings: { ...getDefaultSettings(''), activeRuntimeEnvironmentId: 'remote-1' },
      jiraIssueCache: {
        'site-1::ENG-1': { data: { ...issue, title: 'Remote title' }, fetchedAt: 1 }
      },
      jiraSearchCache: {
        'site-1::list::assigned::30': { data: [{ ...issue, title: 'Remote title' }], fetchedAt: 1 }
      }
    })
    const before = store.getState()

    store
      .getState()
      .patchJiraIssue('ENG-1', { title: 'Late local title' }, { siteId: 'site-1', contextKey })

    expect(store.getState()).toBe(before)
  })

  it('ignores default-source settlements from an earlier paired session on the same host', () => {
    const store = createTestStore()
    store.setState({
      settings: { ...getDefaultSettings(''), activeRuntimeEnvironmentId: 'remote-1' }
    })
    const contextKey = getProviderRuntimeContextKey(store.getState().settings)
    store.setState({
      jiraIssueCache: { 'site-1::ENG-1': { data: issue, fetchedAt: 1 } }
    })
    const before = store.getState()
    bumpProviderRuntimeSessionGeneration()

    store
      .getState()
      .patchJiraIssue('ENG-1', { title: 'Late title' }, { contextKey, siteId: 'site-1' })

    expect(store.getState()).toBe(before)
  })

  it('does not replay a pending edit into a new paired session on the same host', async () => {
    const settings = { activeRuntimeEnvironmentId: 'remote-1' }
    const firstScope = jiraIssueRequestScope(issue, null, settings)
    if (!firstScope) {
      throw new Error('Expected an issue scope')
    }
    let finishSave: (result: JiraMutationResult) => void = () => undefined
    const pendingSave = new Promise<JiraMutationResult>((resolve) => {
      finishSave = resolve
    })
    const save = enqueueJiraIssueMutation({
      scope: firstScope,
      previous: issue,
      optimistic: { title: 'Previous session edit' },
      update: () => pendingSave,
      refresh: async () => issue,
      patchIssue: vi.fn()
    })
    bumpProviderRuntimeSessionGeneration()
    const nextScope = jiraIssueRequestScope(issue, null, settings)
    if (!nextScope) {
      throw new Error('Expected an issue scope')
    }
    const replay = vi.fn()
    const unsubscribe = subscribeJiraIssueMutation(nextScope, vi.fn(), replay)
    finishSave({ ok: true })
    await save
    unsubscribe()

    expect(replay).not.toHaveBeenCalled()
  })

  it('still settles explicit-source saves after the default execution host changes', () => {
    const store = createTestStore()
    const contextKey = getJiraReadIdentity(store.getState().settings, source).contextKey
    const cacheKey = `${getTaskSourceCacheScope(source)}::site-1::ENG-1`
    store.setState({
      settings: { ...getDefaultSettings(''), activeRuntimeEnvironmentId: 'remote-1' },
      jiraIssueCache: { [cacheKey]: { data: issue, fetchedAt: 1 } }
    })

    store
      .getState()
      .patchJiraIssue(
        'ENG-1',
        { title: 'Saved explicit title' },
        { sourceContext: source, contextKey, siteId: 'site-1' }
      )

    expect(store.getState().jiraIssueCache[cacheKey]?.data?.title).toBe('Saved explicit title')
  })

  it('keeps explicit-source saves ordered when the default host session changes', async () => {
    let finishSave: (result: JiraMutationResult) => void = () => undefined
    const pendingSave = new Promise<JiraMutationResult>((resolve) => {
      finishSave = resolve
    })
    const settings = { activeRuntimeEnvironmentId: null }
    const firstScope = jiraIssueRequestScope(issue, source, settings)
    if (!firstScope) {
      throw new Error('Expected an issue scope')
    }
    const patchIssue = vi.fn()
    const firstSave = enqueueJiraIssueMutation({
      scope: firstScope,
      previous: issue,
      optimistic: { title: 'First edit' },
      update: () => pendingSave,
      refresh: async () => issue,
      patchIssue
    })
    bumpProviderRuntimeSessionGeneration()
    const nextScope = jiraIssueRequestScope(issue, source, settings)
    if (!nextScope) {
      throw new Error('Expected an issue scope')
    }
    const update = vi.fn(async (): Promise<JiraMutationResult> => ({ ok: true }))
    const nextSave = enqueueJiraIssueMutation({
      scope: nextScope,
      previous: issue,
      optimistic: { title: 'Later edit' },
      update,
      refresh: async () => ({ ...issue, title: 'Later edit' }),
      patchIssue
    })
    await Promise.resolve()
    const newerStartedBeforeOlderSettled = update.mock.calls.length > 0
    finishSave({ ok: false, error: 'First edit rejected' })
    await Promise.allSettled([firstSave, nextSave])

    expect(newerStartedBeforeOlderSettled).toBe(false)
    expect(patchIssue).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Later edit' }))
  })
})
