import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  owner: vi.fn<() => string | null>(),
  target: vi.fn(),
  supports: vi.fn<() => Promise<boolean>>()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/runtime/structured-agent-session-owner', () => ({
  resolveStructuredAgentSessionOwner: mocks.owner,
  structuredAgentSessionTargetForHost: mocks.target
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supports
}))

import { structuredChatHostRunsReviewReplies } from './structured-agent-session-review-reply-support'

describe('whether a structured chat here can carry a review reply', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('can on this client own host, asking no one', async () => {
    mocks.target.mockReturnValue({ kind: 'local' })
    await expect(structuredChatHostRunsReviewReplies('wt-1')).resolves.toBe(true)
    expect(mocks.supports).not.toHaveBeenCalled()
  })

  it('can on a paired host only once it says so', async () => {
    mocks.target.mockReturnValue({ kind: 'environment', environmentId: 'env-1' })
    mocks.supports.mockResolvedValueOnce(true)
    await expect(structuredChatHostRunsReviewReplies('wt-1')).resolves.toBe(true)
    expect(mocks.supports).toHaveBeenCalledWith('env-1', 'agent-session.review-reply.v1')

    mocks.supports.mockResolvedValueOnce(false)
    await expect(structuredChatHostRunsReviewReplies('wt-1')).resolves.toBe(false)
    mocks.supports.mockRejectedValueOnce(new Error('unreachable'))
    await expect(structuredChatHostRunsReviewReplies('wt-1')).resolves.toBe(false)
  })
})
