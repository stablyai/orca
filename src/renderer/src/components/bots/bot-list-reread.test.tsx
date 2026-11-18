// @vitest-environment happy-dom
// A bots.list re-read hands every bot a new object; views about one bot must not start over on it.
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))

import { useComposioApps } from './composio/ComposioCatalog'
import { useBotShareCandidate } from './sharing/use-bot-share-candidate'

afterEach(() => {
  cleanup()
  mocks.callRuntimeRpc.mockReset()
})

const listed = { hostId: 'local', id: 'bot-1', name: 'Atlas' } as const
const reread = { ...listed }

function calls(method: string): number {
  return mocks.callRuntimeRpc.mock.calls.filter(([, called]) => called === method).length
}

describe('a bots.list re-read with the bot unchanged', () => {
  it('keeps the Composio catalog it loaded', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ apps: [], nextCursor: null })
    const view = renderHook(({ bot }) => useComposioApps(bot, '', 0), {
      initialProps: { bot: listed }
    })
    await waitFor(() => expect(view.result.current.listing.status).toBe('ready'))

    view.rerender({ bot: reread })

    expect(view.result.current.listing.status).toBe('ready')
    expect(calls('bots.composio.apps')).toBe(1)
  })

  it('keeps the Share dialog’s candidate instead of preparing a new one', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ candidate: { candidateId: 'c1' } })
    const view = renderHook(({ bot }) => useBotShareCandidate(bot, 'last'), {
      initialProps: { bot: listed }
    })
    await waitFor(() => expect(view.result.current.building).toBe(false))

    view.rerender({ bot: reread })

    expect(view.result.current.building).toBe(false)
    expect(calls('bots.share.prepare')).toBe(1)
  })
})
