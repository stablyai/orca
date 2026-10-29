// @vitest-environment happy-dom

import { JIRA_IMAGE_CAPABILITY } from '../../../shared/jira/jira-attachment-image'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  jiraAddIssueCommentForTarget,
  jiraGetIssueForTarget,
  jiraIssueCommentsForTarget,
  jiraListPrioritiesForTarget,
  jiraListTransitionsForTarget,
  jiraUpdateIssueForTarget,
  jiraListAssignableUsersForTarget
} from './runtime-jira-client'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { createCompatibleRuntimeStatusResponse } from './runtime-compatibility-test-fixture'
import { RuntimeRpcCallError } from './runtime-rpc-result'

const runtimeCall = vi.fn()
const runtimeSubscribe = vi.fn()
const localMethods = {
  addIssueComment: vi.fn(),
  getIssue: vi.fn(),
  issueComments: vi.fn(),
  listPriorities: vi.fn(),
  listTransitions: vi.fn(),
  listAssignableUsers: vi.fn(),
  updateIssue: vi.fn()
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeCall.mockReset()
  runtimeSubscribe.mockReset()
  for (const method of Object.values(localMethods)) {
    method.mockReset().mockResolvedValue([])
  }
  vi.stubGlobal('window', {
    api: {
      jira: localMethods,
      runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe }
    }
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('captured Jira detail owners', () => {
  it('preserves remote owner, timeouts, and assignable-user query bounds', async () => {
    runtimeCall.mockImplementation(async (args: { method: string }) =>
      args.method === 'status.get'
        ? createCompatibleRuntimeStatusResponse()
        : { id: 'rpc-1', ok: true, result: [], _meta: { runtimeId: 'runtime-1' } }
    )
    const owner = { kind: 'environment', environmentId: 'env-1' } as const
    await jiraUpdateIssueForTarget(owner, 'ENG-1', { title: 'Edited' }, 'site-1')
    await jiraAddIssueCommentForTarget(owner, 'ENG-1', 'Comment', 'site-1')
    await jiraListTransitionsForTarget(owner, 'ENG-1', 'site-1')
    await jiraListPrioritiesForTarget(owner, 'site-1')
    await jiraListAssignableUsersForTarget(owner, 'ENG-1', 'Ada', 'site-1')
    await jiraListAssignableUsersForTarget(owner, 'ENG-1', 'x'.repeat(20_000), 'site-1')

    for (const method of [
      'updateIssue',
      'addIssueComment',
      'listTransitions',
      'listPriorities',
      'listAssignableUsers'
    ]) {
      expect(runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: `jira.${method}`, selector: 'env-1', timeoutMs: 30_000 })
      )
    }
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'jira.listTransitions',
        selector: 'env-1',
        params: { key: 'ENG-1', siteId: 'site-1', strict: true }
      })
    )
    expect(
      runtimeCall.mock.calls.filter(([args]) => args.method === 'jira.listAssignableUsers')
    ).toHaveLength(1)
    for (const method of Object.values(localMethods)) {
      expect(method).not.toHaveBeenCalled()
    }
  })

  it('keeps legacy one-shot detail fallback on the captured remote owner', async () => {
    runtimeSubscribe.mockRejectedValue(
      new RuntimeRpcCallError({
        id: 'rpc-1',
        ok: false,
        error: { code: 'method_not_found', message: 'Old host' }
      })
    )
    const status = createCompatibleRuntimeStatusResponse()
    if (!status.ok) {
      throw new Error('Expected successful status')
    }
    status.result.capabilities = status.result.capabilities?.filter(
      (capability) => capability !== JIRA_IMAGE_CAPABILITY
    )
    runtimeCall.mockImplementation(async (args: { method: string }) =>
      args.method === 'status.get'
        ? status
        : {
            id: 'rpc-1',
            ok: true,
            result: args.method === 'jira.getIssue' ? { key: 'ENG-1' } : [],
            _meta: { runtimeId: 'runtime-1' }
          }
    )
    const owner = { kind: 'environment', environmentId: 'env-1' } as const
    await expect(jiraGetIssueForTarget(owner, 'ENG-1', 'site-1')).resolves.toMatchObject({
      key: 'ENG-1'
    })
    await expect(jiraIssueCommentsForTarget(owner, 'ENG-1', 'site-1')).resolves.toEqual([])

    for (const method of ['jira.getIssue', 'jira.issueComments']) {
      expect(runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({
          method,
          selector: 'env-1',
          params: { key: 'ENG-1', siteId: 'site-1' },
          timeoutMs: 30_000
        })
      )
    }
    expect(localMethods.getIssue).not.toHaveBeenCalled()
    expect(localMethods.issueComments).not.toHaveBeenCalled()
  })
})
