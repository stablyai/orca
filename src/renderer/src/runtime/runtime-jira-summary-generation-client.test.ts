// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  supports: vi.fn(),
  local: vi.fn(),
  cancel: vi.fn()
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.rpc,
  runtimeEnvironmentSupportsCapability: mocks.supports
}))
import {
  generateRuntimeJiraIssueSummary,
  cancelRuntimeJiraIssueSummary
} from './runtime-jira-summary-generation-client'
const args = { description: 'Draft', siteId: 'site-1', requestId: 'req-1', draftId: 'draft-1' }
const target = { kind: 'environment', environmentId: 'ssh-1' } as const
beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { jira: { generateIssueSummary: mocks.local, cancelGenerateIssueSummary: mocks.cancel } }
  })
  mocks.supports.mockResolvedValue(true)
  mocks.rpc.mockResolvedValue({ success: true, summary: 'Title' })
})
describe('Jira generation routing', () => {
  it('runs and stops on the selected host with the same account and request', async () => {
    const abort = new AbortController()
    await generateRuntimeJiraIssueSummary(target, args, abort.signal)
    await cancelRuntimeJiraIssueSummary(target, args)
    expect(mocks.rpc).toHaveBeenCalledWith(
      target,
      'jira.generateIssueSummary',
      args,
      expect.objectContaining({ signal: abort.signal })
    )
    expect(mocks.rpc).toHaveBeenCalledWith(
      target,
      'jira.cancelGenerateIssueSummary',
      args,
      expect.anything()
    )
    expect(mocks.local).not.toHaveBeenCalled()
    expect(mocks.cancel).not.toHaveBeenCalled()
  })
  it('gives update guidance for an older host without calling a local agent', async () => {
    mocks.supports.mockResolvedValue(false)
    expect(
      await generateRuntimeJiraIssueSummary(target, args, new AbortController().signal)
    ).toMatchObject({ success: false, error: expect.stringContaining('Update') })
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.local).not.toHaveBeenCalled()
  })
  it('never falls back locally after a remote probe fails', async () => {
    mocks.supports.mockRejectedValue(new Error('Disconnected'))
    await expect(
      generateRuntimeJiraIssueSummary(target, args, new AbortController().signal)
    ).rejects.toThrow('Disconnected')
    expect(mocks.local).not.toHaveBeenCalled()
  })
  it('keeps an unknown remote generation method failure on its owner', async () => {
    mocks.rpc.mockRejectedValue(new Error('method_not_found'))
    await expect(
      generateRuntimeJiraIssueSummary(target, args, new AbortController().signal)
    ).rejects.toThrow('method_not_found')
    expect(mocks.local).not.toHaveBeenCalled()
  })
  it('does not dispatch after cancellation during the capability probe', async () => {
    const abort = new AbortController()
    mocks.supports.mockImplementation(async () => {
      abort.abort()
      return true
    })
    expect(await generateRuntimeJiraIssueSummary(target, args, abort.signal)).toMatchObject({
      canceled: true
    })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
})
