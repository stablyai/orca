// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jiraGetIssueEditFieldsForTarget, jiraUpdateIssueForTarget } from './runtime-jira-client'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { createCompatibleRuntimeStatusResponse } from './runtime-compatibility-test-fixture'
import { JIRA_ISSUE_EDIT_FIELDS_RUNTIME_CAPABILITY } from '../../../shared/jira/jira-detail-capabilities'

const runtimeCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeCall.mockReset()
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('edit-screen fields on mixed remote versions', () => {
  const target = { kind: 'environment' as const, environmentId: 'env-1' }

  function mockHost(withEditFields: boolean): void {
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'status.get') {
        const response = createCompatibleRuntimeStatusResponse()
        if (!response.ok) {
          throw new Error('Expected status fixture')
        }
        response.result.capabilities = response.result.capabilities?.filter(
          (capability) => withEditFields || capability !== JIRA_ISSUE_EDIT_FIELDS_RUNTIME_CAPABILITY
        )
        return response
      }
      if (args.method === 'jira.getIssueEditFields') {
        return { id: 'rpc-1', ok: true, result: [] }
      }
      return { id: 'rpc-1', ok: true, result: { ok: true } }
    })
  }

  it('hides edit fields and refuses field writes on hosts that would strip them', async () => {
    mockHost(false)
    await expect(jiraGetIssueEditFieldsForTarget(target, 'APP-1', 'site-1')).resolves.toBeNull()
    await expect(
      jiraUpdateIssueForTarget(target, 'APP-1', { fields: { duedate: '2026-10-20' } }, 'site-1')
    ).rejects.toThrow('Update the remote Orca server')
    const methods = runtimeCall.mock.calls.map(([args]) => args.method)
    expect(methods).not.toContain('jira.getIssueEditFields')
    expect(methods).not.toContain('jira.updateIssue')
  })

  it('reads edit fields strictly from hosts that advertise them', async () => {
    mockHost(true)
    await expect(jiraGetIssueEditFieldsForTarget(target, 'APP-1', 'site-1')).resolves.toEqual([])
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'jira.getIssueEditFields',
        params: { key: 'APP-1', siteId: 'site-1', strict: true },
        selector: 'env-1'
      })
    )
  })
})
