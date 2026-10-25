// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { JiraIssueListFilters } from '../../../shared/jira/jira-types'
import { JIRA_STATUS_FILTER_RUNTIME_CAPABILITY } from '../../../shared/jira/jira-quick-filters'
import { JIRA_CURRENT_SPRINT_RUNTIME_CAPABILITY } from '../../../shared/jira/jira-detail-capabilities'
import { jiraListIssues } from './runtime-jira-client'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { createCompatibleRuntimeStatusResponse } from './runtime-compatibility-test-fixture'

const call = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  call.mockReset()
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
})

afterEach(() => vi.unstubAllGlobals())

it.each([
  {
    missing: JIRA_CURRENT_SPRINT_RUNTIME_CAPABILITY,
    supported: { statuses: ['Blocked'] }
  },
  {
    missing: JIRA_STATUS_FILTER_RUNTIME_CAPABILITY,
    supported: { currentSprint: true }
  }
])(
  'keeps the supported filter usable when $missing is unavailable',
  async ({ missing, supported }) => {
    call.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'status.get') {
        const status = createCompatibleRuntimeStatusResponse()
        if (!status.ok) {
          throw new Error('Expected successful compatibility fixture')
        }
        status.result.capabilities = status.result.capabilities?.filter((item) => item !== missing)
        return status
      }
      return { id: 'board-filter', ok: true, result: [] }
    })
    const source = { kind: 'environment' as const, environmentId: `board-${missing}` }
    await expect(jiraListIssues(source, 'all', 50, 'site-a', supported)).resolves.toEqual([])
    expect(call.mock.calls.filter(([args]) => args.method === 'jira.listIssues')).toHaveLength(1)

    const combined: JiraIssueListFilters = { statuses: ['Blocked'], currentSprint: true }
    await expect(jiraListIssues(source, 'all', 50, 'site-a', combined)).rejects.toThrow(
      /Update (the remote Orca server|the Jira host)/
    )
    expect(call.mock.calls.filter(([args]) => args.method === 'jira.listIssues')).toHaveLength(1)
  }
)

it('forwards both filters to a host that supports the combined board query', async () => {
  call.mockImplementation(async (args: { method: string }) =>
    args.method === 'status.get'
      ? createCompatibleRuntimeStatusResponse()
      : { id: 'board-filter', ok: true, result: [] }
  )
  const filters = { statuses: ['Blocked'], currentSprint: true }
  await jiraListIssues(
    { kind: 'environment', environmentId: 'board-current' },
    'all',
    50,
    'site-a',
    filters
  )
  expect(call).toHaveBeenCalledWith(
    expect.objectContaining({
      selector: 'board-current',
      method: 'jira.listIssues',
      params: { filter: 'all', limit: 50, siteId: 'site-a', filters }
    })
  )
})
