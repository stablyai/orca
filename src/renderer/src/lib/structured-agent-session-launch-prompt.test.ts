// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { enqueueStructuredAgentSessionLaunchPrompt } from '@/components/native-chat/structured-agent-session-outbox-storage'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { settleStructuredAgentLaunchPrompt } from './structured-agent-session-launch-prompt'

describe('settleStructuredAgentLaunchPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '11111111-1111-4111-8111-111111111111'
    )
  })

  it('reports an admitted launch prompt delivered while retaining it for the provider echo', async () => {
    const stagedEntry = enqueueStructuredAgentSessionLaunchPrompt('session-1', 'review this')
    const onPromptDelivered = vi.fn()
    mocks.call.mockResolvedValue({
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'epoch-1', sequence: 1 },
      value: {
        clientMessageId: stagedEntry!.clientMessageId,
        submission: {
          clientMessageId: stagedEntry!.clientMessageId,
          fence: 1,
          payloadFingerprint: 'fingerprint',
          dispatchState: 'pending',
          providerItemId: null,
          reason: null,
          submittedAt: 1,
          resolvedAt: null
        }
      }
    })

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
        options: { prompt: 'review this', onPromptDelivered },
        stagedEntry
      })
    ).resolves.toEqual({ delivered: true, failureNotified: false })

    expect(onPromptDelivered).toHaveBeenCalledOnce()
    const persisted = JSON.parse(localStorage.getItem(localStorage.key(0)!) ?? '[]') as {
      state: string
    }[]
    expect(persisted).toMatchObject([{ state: 'dispatching' }])
  })
})
