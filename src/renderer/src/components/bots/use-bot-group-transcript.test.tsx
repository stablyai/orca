// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import { useBotGroupTranscript } from './use-bot-group-transcript'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(async (_target: unknown, _method: string, _params?: unknown) => ({}))
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: (target: unknown, method: string, params?: unknown) =>
    mocks.rpc(target, method, params)
}))
vi.mock('@/lib/bots-changed-window-event', () => ({ onBotsChanged: () => () => {} }))

// The paired server's own view of its group: it names itself `local`.
const served: BotGroup = {
  id: 'group-1',
  name: 'Crew',
  hostId: 'local',
  revision: 1,
  folder: 'group-crew',
  folderWorkspaceId: 'fw-g',
  createdAt: 1,
  members: [{ botId: 'a', sessionId: 's-a' }],
  replyMode: { kind: 'bot', botId: 'a' }
}

describe('useBotGroupTranscript', () => {
  it("keeps a paired server's group on that server for every later call", async () => {
    mocks.rpc.mockImplementation(async () => ({
      group: served,
      messages: [],
      hasEarlier: true
    }))
    const server = { hostId: 'runtime:ws' as const, id: 'group-1' }
    const setError = vi.fn()
    const { result } = renderHook(() => useBotGroupTranscript(server, undefined, true, setError))
    await waitFor(() => expect(result.current.data).not.toBeNull())
    expect(result.current.data?.group.hostId).toBe('runtime:ws')
    act(() => result.current.loadEarlier())
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2))
    expect(mocks.rpc.mock.calls[1][0]).toEqual({ kind: 'environment', environmentId: 'ws' })
  })
})
