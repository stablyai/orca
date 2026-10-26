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
const image = '![shot](orca-jira-image://attachment/12345678-1234-1234-1234-123456789012)'
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
  it('requests image references through local issue and comment IPC', async () => {
    localIssue.mockResolvedValue({ key: 'JIR-1', description: image })
    localComments.mockResolvedValue([{ id: 'comment', body: image }])
    await expect(jiraGetIssueForTarget({ kind: 'local' }, 'JIR-1', 'site')).resolves.toMatchObject({
      description: image
    })
    await expect(jiraIssueCommentsForTarget({ kind: 'local' }, 'JIR-1', 'site')).resolves.toEqual([
      { id: 'comment', body: image }
    ])
    const args = { key: 'JIR-1', siteId: 'site', mediaFormat: 'reference' }
    expect(localIssue).toHaveBeenCalledWith(args)
    expect(localComments).toHaveBeenCalledWith(args)
    expect(runtimeCall).not.toHaveBeenCalled()
    expect(runtimeSubscribe).not.toHaveBeenCalled()
  })

  it('checks the captured remote owner capability and reads short image references there', async () => {
    runtimeCall.mockImplementation(async (args: { method: string }) =>
      args.method === 'status.get'
        ? createCompatibleRuntimeStatusResponse()
        : {
            id: 'detail',
            ok: true,
            result:
              args.method === 'jira.getIssue'
                ? { key: 'JIR-1', description: image }
                : [{ id: 'comment', body: image }],
            _meta: { runtimeId: 'remote-runtime' }
          }
    )
    await expect(jiraGetIssueForTarget(target, 'JIR-1', 'site')).resolves.toMatchObject({
      description: image
    })
    await expect(jiraIssueCommentsForTarget(target, 'JIR-1', 'site')).resolves.toEqual([
      { id: 'comment', body: image }
    ])
    for (const method of ['status.get', 'jira.getIssue', 'jira.issueComments']) {
      expect(runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({
          selector: 'issue-owner',
          method
        })
      )
    }
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'jira.getIssue',
        params: { key: 'JIR-1', siteId: 'site', mediaFormat: 'reference' }
      })
    )
    expect(localIssue).not.toHaveBeenCalled()
    expect(localComments).not.toHaveBeenCalled()
    expect(runtimeSubscribe).not.toHaveBeenCalled()
  })

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

  it('falls back to the original owner RPC only when an old host lacks the stream method', async () => {
    runtimeCall.mockImplementation(async (args: { method: string }) =>
      args.method === 'status.get'
        ? statusWithoutImages()
        : {
            id: 'detail',
            ok: true,
            result: args.method === 'jira.getIssue' ? null : [],
            _meta: { runtimeId: 'remote-runtime' }
          }
    )
    runtimeSubscribe.mockImplementation(
      async (_args: SubscribeArgs, callbacks: SubscribeCallbacks) => {
        callbacks.onResponse({
          id: 'detail',
          ok: false,
          error: {
            code: 'method_not_found',
            message: 'Unknown method'
          }
        })
        return { unsubscribe: close, sendBinary: vi.fn() }
      }
    )
    await expect(jiraGetIssueForTarget(target, 'JIR-1')).resolves.toBeNull()
    await expect(jiraIssueCommentsForTarget(target, 'JIR-1')).resolves.toEqual([])
    for (const method of ['jira.getIssue', 'jira.issueComments']) {
      expect(runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({
          selector: 'issue-owner',
          method,
          params: { key: 'JIR-1', siteId: undefined },
          timeoutMs: 30_000
        })
      )
    }
    expect(localIssue).not.toHaveBeenCalled()
    expect(localComments).not.toHaveBeenCalled()
  })

  it('preserves stream errors instead of retrying failed reads through another path', async () => {
    runtimeCall.mockResolvedValue(statusWithoutImages())
    runtimeSubscribe.mockImplementation(
      async (_args: SubscribeArgs, callbacks: SubscribeCallbacks) => {
        callbacks.onResponse({
          id: 'detail',
          ok: false,
          error: {
            code: 'forbidden',
            message: 'Access denied'
          }
        })
        return { unsubscribe: close, sendBinary: vi.fn() }
      }
    )
    await expect(jiraGetIssueForTarget(target, 'JIR-1')).rejects.toMatchObject({
      code: 'forbidden'
    })
    await expect(jiraIssueCommentsForTarget(target, 'JIR-1')).rejects.toMatchObject({
      code: 'forbidden'
    })
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'jira.getIssue' })
    )
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'jira.issueComments' })
    )
    expect(localIssue).not.toHaveBeenCalled()
    expect(localComments).not.toHaveBeenCalled()
  })
})
