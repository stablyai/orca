// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { jiraListIssues, jiraListIssuesForTarget } from './runtime-jira-client'
import {
  readJiraQuickFilterState,
  writeJiraQuickFilterState
} from './runtime-jira-quick-filter-state'
import { JIRA_STATUS_FILTER_RUNTIME_CAPABILITY } from '../../../shared/jira/jira-quick-filters'
const { assertCapability, rpc } = vi.hoisted(() => ({ assertCapability: vi.fn(), rpc: vi.fn() }))
vi.mock('./runtime-rpc-client', () => ({
  assertRuntimeEnvironmentCapability: assertCapability,
  callRuntimeRpc: rpc
}))
beforeEach(() => {
  vi.resetAllMocks()
})
afterEach(() => {
  vi.unstubAllGlobals()
})
const target = { kind: 'environment', environmentId: 'jira-owner' } as const
it('keeps the old request shape when no statuses are selected', async () => {
  rpc.mockResolvedValue([])
  await jiraListIssues(target, 'all', 50, 'site-a')
  expect(assertCapability).not.toHaveBeenCalled()
  expect(rpc).toHaveBeenCalledWith(
    target,
    'jira.listIssues',
    { filter: 'all', limit: 50, siteId: 'site-a' },
    { timeoutMs: 30_000 }
  )
})
it('gates status list filters on the called execution host', async () => {
  rpc.mockResolvedValue([])
  await jiraListIssuesForTarget(target, 'all', 50, 'site-a', { statuses: ['In Progress'] })
  expect(assertCapability).toHaveBeenCalledWith(
    'jira-owner',
    JIRA_STATUS_FILTER_RUNTIME_CAPABILITY,
    expect.any(String),
    15_000
  )
  expect(rpc).toHaveBeenCalledWith(
    target,
    'jira.listIssues',
    { filter: 'all', limit: 50, siteId: 'site-a', filters: { statuses: ['In Progress'] } },
    { timeoutMs: 30_000 }
  )
})
it('refuses an older host without silently dropping selection or writing strict resume fields', async () => {
  assertCapability.mockRejectedValue(new Error('Update the Jira host'))
  await expect(
    jiraListIssues(target, 'all', 50, 'site-a', { statuses: ['Blocked'] })
  ).rejects.toThrow('Update')
  await expect(writeJiraQuickFilterState(target, { statuses: ['Blocked'] })).rejects.toThrow(
    'Update'
  )
  expect(rpc).not.toHaveBeenCalled()
})
it('routes persisted state through host UI methods and acknowledges the write', async () => {
  rpc.mockResolvedValue({ statuses: ['Blocked'] })
  expect(await readJiraQuickFilterState(target)).toEqual({ statuses: ['Blocked'] })
  expect(await writeJiraQuickFilterState(target, { statuses: ['Blocked'] })).toEqual({
    statuses: ['Blocked']
  })
  expect(rpc).toHaveBeenLastCalledWith(
    target,
    'ui.setJiraQuickFilters',
    { statuses: ['Blocked'] },
    { timeoutMs: 15_000 }
  )
})
it('uses local IPC and reports a lost write instead of pretending to save', async () => {
  const read = vi.fn(async () => ({ statuses: ['Open'] }))
  const write = vi.fn(async () => {
    throw new Error('Lost host')
  })
  vi.stubGlobal('window', {
    api: { ui: { getJiraQuickFilters: read, setJiraQuickFilters: write } }
  })
  expect(await readJiraQuickFilterState({ kind: 'local' })).toEqual({ statuses: ['Open'] })
  await expect(writeJiraQuickFilterState({ kind: 'local' }, { statuses: [] })).rejects.toThrow(
    'Lost host'
  )
  expect(rpc).not.toHaveBeenCalled()
})
