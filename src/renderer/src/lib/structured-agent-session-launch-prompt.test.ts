// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  enqueueStructuredAgentSessionLaunchPrompt,
  mutateStructuredAgentSessionLaunchPrompt,
  readOutbox
} from '@/components/native-chat/structured-agent-session-outbox-storage'

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
        target: { kind: 'local' },
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

  it('drops the previous attempt failure when the launch path sends the message again', async () => {
    const stagedEntry = enqueueStructuredAgentSessionLaunchPrompt('session-1', 'review this')
    mutateStructuredAgentSessionLaunchPrompt(
      'session-1',
      stagedEntry!.clientMessageId,
      (entry) => ({
        ...entry,
        lastFailure: { kind: 'refused', code: 'agent_session_operation_capacity' }
      })
    )
    mocks.call.mockResolvedValue({
      ok: false,
      refusal: { code: 'agent_session_checkpoint_stale', message: 'stale' }
    })

    await settleStructuredAgentLaunchPrompt({
      launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
      target: { kind: 'local' },
      options: { prompt: 'review this' },
      stagedEntry
    })

    const persisted: unknown = JSON.parse(localStorage.getItem(localStorage.key(0)!) ?? '[]')
    expect(persisted).toHaveLength(1)
    expect(persisted).not.toContainEqual(
      expect.objectContaining({ lastFailure: expect.anything() })
    )
  })
})

describe('a launch prompt the host did not record', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('is held by its chat when the chat keeps it to send again, and not when nothing is kept', async () => {
    const stagedEntry = enqueueStructuredAgentSessionLaunchPrompt('session-1', 'review this')
    mocks.call.mockResolvedValue({
      ok: false,
      refusal: { code: 'agent_session_checkpoint_stale', message: 'stale' }
    })
    const settle = (launchResult: Promise<{ sessionId: string; fence: number }>) =>
      settleStructuredAgentLaunchPrompt({
        launchResult,
        target: { kind: 'local' },
        options: { prompt: 'review this' },
        stagedEntry
      })

    await expect(settle(Promise.resolve({ sessionId: 'session-1', fence: 1 }))).resolves.toEqual({
      delivered: false,
      failureNotified: false,
      heldByChat: true
    })
    mutateStructuredAgentSessionLaunchPrompt('session-1', stagedEntry!.clientMessageId, () => null)
    await expect(settle(Promise.resolve({ sessionId: 'session-1', fence: 1 }))).resolves.toEqual({
      delivered: false,
      failureNotified: false
    })
  })

  it('says the message carries the review reply only when the chat took a prompt that had one', async () => {
    const reviewReply = { provider: 'gitlab' as const, repoId: 'repo-1', iid: 8, resolve: ['d-1'] }
    const withReply = enqueueStructuredAgentSessionLaunchPrompt('session-1', 'fix', reviewReply)
    const plain = enqueueStructuredAgentSessionLaunchPrompt('session-2', 'fix')
    mocks.call.mockImplementation(
      async (
        _target: unknown,
        _method: string,
        request: { envelope: { clientOperationId: string } }
      ) => ({
        ok: true,
        replayed: false,
        fence: 1,
        cursor: { epoch: 'epoch-1', sequence: 1 },
        value: {
          clientMessageId: request.envelope.clientOperationId,
          submission: {
            clientMessageId: request.envelope.clientOperationId,
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
    )
    const settle = (stagedEntry: typeof plain, sessionId: string) =>
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId, fence: 1 }),
        target: { kind: 'local' },
        options: { prompt: 'fix' },
        stagedEntry
      })

    await expect(settle(withReply, 'session-1')).resolves.toEqual({
      delivered: true,
      failureNotified: false,
      reviewReplyCarried: true
    })
    await expect(settle(plain, 'session-2')).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
  })

  it('keeps no review reply on a prompt whose create failed, as the source takes its comments back', async () => {
    const reviewReply = { provider: 'gitlab' as const, repoId: 'repo-1', iid: 8, resolve: ['d-1'] }
    const stagedEntry = enqueueStructuredAgentSessionLaunchPrompt(
      'session-1',
      'review this',
      reviewReply
    )

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.reject(new Error('create failed')),
        target: { kind: 'local' },
        options: { prompt: 'review this' },
        stagedEntry
      })
    ).rejects.toThrow('create failed')

    const [kept] = readOutbox('session-1')
    expect(kept).toMatchObject({ clientMessageId: stagedEntry!.clientMessageId })
    expect(kept).not.toHaveProperty('reviewReply')
  })
})
