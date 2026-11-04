import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { JiraIssue, JiraMutationResult } from '../../../../shared/jira/jira-types'
import '../../../../shared/task-source-context'
import '@/lib/provider-runtime-context'
import { getJiraReadIdentity } from './jira-read-coordination'
import {
  enqueueJiraIssueMutation,
  jiraIssueRequestScope
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
})
