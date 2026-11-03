// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jiraGetIssueForTarget, jiraIssueCommentsForTarget } from './runtime-jira-detail-client'
import { JIRA_IMAGE_CAPABILITY } from '../../../shared/jira/jira-attachment-image'
import { clearJiraImageCache, hasCachedJiraImage } from './runtime-jira-image-cache'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { createCompatibleRuntimeStatusResponse } from './runtime-compatibility-test-fixture'

type SubscribeArgs = Parameters<typeof window.api.runtimeEnvironments.subscribe>[0]
type SubscribeCallbacks = Parameters<typeof window.api.runtimeEnvironments.subscribe>[1]
const target = { kind: 'environment' as const, environmentId: 'issue-owner' }
const localIssue = vi.fn()
const localComments = vi.fn()
const runtimeCall = vi.fn()
const runtimeSubscribe = vi.fn()
const close = vi.fn()

function statusWithoutImages() {
  const response = createCompatibleRuntimeStatusResponse()
  if (!response.ok) {
    throw new Error('Expected a successful compatibility fixture')
  }
  response.result.capabilities = response.result.capabilities?.filter(
    (capability) => capability !== JIRA_IMAGE_CAPABILITY
  )
  return response
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  localIssue.mockReset()
  localComments.mockReset()
  runtimeCall.mockReset()
  runtimeSubscribe.mockReset()
  close.mockReset()
  vi.stubGlobal('window', {
    api: {
      jira: { getIssue: localIssue, issueComments: localComments },
      runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe }
    }
  })
})

afterEach(() => {
  clearJiraImageCache()
  vi.unstubAllGlobals()
})

describe('captured Jira detail owners', () => {
  it('keeps old-host streams and migrated image bytes under their captured owner', async () => {
    runtimeCall.mockResolvedValue(statusWithoutImages())
    runtimeSubscribe.mockImplementation(
      async (args: SubscribeArgs, callbacks: SubscribeCallbacks) => {
        const body = '![shot](data:image/png;base64,AQ==)'
        const payload =
          args.method === 'jira.getIssueStream'
            ? { key: 'JIR-1', description: body }
            : [{ id: 'comment', body }]
        for (const result of [
          { type: 'chunk', content: JSON.stringify(payload) },
          { type: 'end' }
        ]) {
          callbacks.onResponse({
            id: 'detail',
            ok: true,
            result,
            _meta: { runtimeId: 'remote-runtime' }
          })
        }
        return { unsubscribe: close, sendBinary: vi.fn() }
      }
    )
    const issue = await jiraGetIssueForTarget(target, 'JIR-1', 'site')
    const comments = await jiraIssueCommentsForTarget(target, 'JIR-1', 'site')
    for (const body of [issue?.description, comments[0]?.body]) {
      const reference = body?.match(/orca-jira-image:\/\/attachment\/([^)]+)/)?.[1]
      if (!reference) {
        throw new Error('Expected a migrated image reference')
      }
      expect(hasCachedJiraImage(target, reference)).toBe(true)
      expect(
        hasCachedJiraImage({ kind: 'environment', environmentId: 'other-owner' }, reference)
      ).toBe(false)
    }
    for (const method of ['jira.getIssueStream', 'jira.issueCommentsStream']) {
      expect(runtimeSubscribe).toHaveBeenCalledWith(
        {
          selector: 'issue-owner',
          method,
          params: { key: 'JIR-1', siteId: 'site' },
          timeoutMs: 60_000
        },
        expect.anything()
      )
    }
    await Promise.resolve()
    expect(close).toHaveBeenCalledTimes(2)
  })
})
