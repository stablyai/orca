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
import { generateRuntimeJiraIssueSummary } from './runtime-jira-summary-generation-client'
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
