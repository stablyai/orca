// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type * as BotHosts from '@/lib/bot-hosts'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import type { Bot } from '../../../../shared/bot-types'
import { useBotActivityAuthorityRead, useBotActivityRead } from './use-bot-activity'

// Only the transport is stubbed: each activity read waits on a deferred the test settles.
const replies: ((value: unknown) => void)[] = []
type BotHostsModule = typeof BotHosts
vi.mock('@/lib/bot-hosts', async (importOriginal) => ({
  ...(await importOriginal<BotHostsModule>()),
  callBotRpc: () => new Promise((resolve) => replies.push(resolve))
}))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read keys on host, id and folder only.
const bot = {
  id: 'b1',
  hostId: 'runtime:env-a',
  folderWorkspaceId: 'f1',
  chatSessionId: null
} as unknown as Bot
const activity = (name: string) => ({
  activity: { workers: [], inProgress: [], completed: [], automations: [], waits: [], name }
})

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve()
    }
  })
}

describe('the Activity read', () => {
  it('renders plain readers only for Activity changes, not for a new incarnation alone', async () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-a', createdAt: 1, pairingRevision: 11 }])
    let plainRenders = 0
    const plain = renderHook(() => {
      plainRenders += 1
      return useBotActivityRead(bot)
    })
    const owner = renderHook(() => useBotActivityAuthorityRead(bot))
    await settle()
    replies.splice(0).forEach((reply) => reply(activity('one')))
    await settle()
    const first = plain.result.current
    expect(owner.result.current.read?.authority).toMatchObject({ pairingRevision: 11 })
    const rendersAfterFirst = plainRenders

    replaceRuntimeEnvironmentRevisions([{ id: 'env-a', createdAt: 1, pairingRevision: 22 }])
    act(() => owner.result.current.refresh())
    await settle()
    replies.splice(0).forEach((reply) => reply(activity('one')))
    await settle()
    expect(owner.result.current.read?.authority).toMatchObject({ pairingRevision: 22 })
    expect(plain.result.current).toBe(first)
    expect(plainRenders).toBe(rendersAfterFirst)

    act(() => owner.result.current.refresh())
    await settle()
    replies.splice(0).forEach((reply) => reply(activity('two')))
    await settle()
    expect(plain.result.current).not.toBe(first)
    expect(plainRenders).toBeGreaterThan(rendersAfterFirst)
  })
})
