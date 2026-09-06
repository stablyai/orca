// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OmpRpcChatHandbackPayload } from '../../../../shared/omp-rpc-chat-ipc-contract'

const { respawnPtyForOmpRpcChatHandback } = vi.hoisted(() => ({
  respawnPtyForOmpRpcChatHandback: vi.fn()
}))

vi.mock('./omp-rpc-chat-handback', () => ({ respawnPtyForOmpRpcChatHandback }))

import { useOmpRpcChatHandbackListener } from './use-omp-rpc-chat-handback-listener'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'

const onHandback = vi.fn<(onEvent: (payload: OmpRpcChatHandbackPayload) => void) => () => void>()
const claimPendingHandbacks = vi.fn<(args: { tabId: string }) => Promise<unknown[]>>()
const settleHandback = vi.fn<(args: unknown) => Promise<void>>()

/** A claim is a LEASE (XLR-R8-001): main hands over the payload plus the token
 *  the respawn's outcome must be reported under. */
function lease(token: string, overrides: Partial<OmpRpcChatHandbackPayload> = {}) {
  return {
    token,
    payload: {
      paneKey: `tab-1:${LEAF_ID}`,
      replacedPtyId: 'pty-1',
      cwd: '/work/a',
      sessionId: 'session-1',
      ...overrides
    }
  }
}

function fireHandback(payload: OmpRpcChatHandbackPayload): void {
  const listener = onHandback.mock.calls.at(-1)?.[0]
  if (!listener) {
    throw new Error('onHandback was never subscribed')
  }
  listener(payload)
}

/** Lets the claim's promise settle so the respawn it authorizes can run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  vi.clearAllMocks()
  onHandback.mockReturnValue(vi.fn())
  claimPendingHandbacks.mockResolvedValue([])
  settleHandback.mockResolvedValue(undefined)
  respawnPtyForOmpRpcChatHandback.mockResolvedValue({
    ok: true,
    ptyId: 'pty-resumed'
  })
  ;(window as unknown as { api: unknown }).api = {
    ompRpcChat: { onHandback, claimPendingHandbacks, settleHandback }
  }
})

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('useOmpRpcChatHandbackListener', () => {
  // The respawn is driven by what main HANDS OVER, never by the pushed payload
  // (XLR-R7-001): the claim is the single consume, so several nudges for one
  // release cannot launch several `omp --resume` children on one session.
  it('claims and respawns when a nudge for this tab arrives', async () => {
    claimPendingHandbacks.mockResolvedValue([lease('handback-1')])
    renderHook(() => useOmpRpcChatHandbackListener('tab-1'))

    fireHandback({
      paneKey: `tab-1:${LEAF_ID}`,
      replacedPtyId: 'pty-1',
      cwd: '/work/a',
      sessionId: 'session-1'
    })
    await flush()

    expect(claimPendingHandbacks).toHaveBeenCalledWith({ tabId: 'tab-1' })
    expect(respawnPtyForOmpRpcChatHandback).toHaveBeenCalledWith({
      paneKey: `tab-1:${LEAF_ID}`,
      replacedPtyId: 'pty-1',
      cwd: '/work/a',
      sessionId: 'session-1'
    })
  })

  // A `webContents.send` cannot be replayed, so a renderer reloaded while the
  // bounded release was still proving settle+exit never saw the nudge at all.
  // Mounting is the only signal it produces, and main retained the
  // instruction for exactly this claim (XLR-R7-001).
  it('claims on mount so a reloaded renderer still recovers its PTY', async () => {
    claimPendingHandbacks.mockResolvedValue([lease('handback-1')])

    renderHook(() => useOmpRpcChatHandbackListener('tab-1'))
    await flush()

    expect(claimPendingHandbacks).toHaveBeenCalledWith({ tabId: 'tab-1' })
    expect(respawnPtyForOmpRpcChatHandback).toHaveBeenCalledWith({
      paneKey: `tab-1:${LEAF_ID}`,
      replacedPtyId: 'pty-1',
      cwd: '/work/a',
      sessionId: 'session-1'
    })
  })

  it('respawns nothing when main retained no instruction for this tab', async () => {
    renderHook(() => useOmpRpcChatHandbackListener('tab-1'))
    await flush()

    expect(respawnPtyForOmpRpcChatHandback).not.toHaveBeenCalled()
  })

  it('treats an absent paired-web claim result as no pending handbacks', async () => {
    claimPendingHandbacks.mockResolvedValue(undefined as never)

    renderHook(() => useOmpRpcChatHandbackListener('tab-1'))
    await flush()

    expect(respawnPtyForOmpRpcChatHandback).not.toHaveBeenCalled()
  })

  it('leaves the instruction with main when the claim cannot be answered', async () => {
    claimPendingHandbacks.mockRejectedValue(new Error('no ipc'))
    renderHook(() => useOmpRpcChatHandbackListener('tab-1'))
    await flush()

    expect(respawnPtyForOmpRpcChatHandback).not.toHaveBeenCalled()
  })

  // Why: the push event is a broadcast, not scoped per subscriber like
  // `ompRpcChat:subscribe` — every mounted TerminalPane's listener fires and
  // must filter out payloads belonging to a sibling tab itself.
  it('ignores a nudge for a different tab', async () => {
    renderHook(() => useOmpRpcChatHandbackListener('tab-1'))
    await flush()
    claimPendingHandbacks.mockClear()

    fireHandback({
      paneKey: `tab-2:${OTHER_LEAF_ID}`,
      replacedPtyId: 'pty-2',
      cwd: '/work/b',
      sessionId: 'session-2'
    })

    expect(claimPendingHandbacks).not.toHaveBeenCalled()
  })

  it('ignores a malformed paneKey rather than throwing', async () => {
    renderHook(() => useOmpRpcChatHandbackListener('tab-1'))
    await flush()
    claimPendingHandbacks.mockClear()

    expect(() =>
      fireHandback({
        paneKey: 'not-a-valid-pane-key',
        replacedPtyId: 'pty-1',
        cwd: '/work/a',
        sessionId: 'session-1'
      })
    ).not.toThrow()
    expect(claimPendingHandbacks).not.toHaveBeenCalled()
  })

  it('unsubscribes on unmount', () => {
    const unsubscribe = vi.fn()
    onHandback.mockReturnValue(unsubscribe)
    const { unmount } = renderHook(() => useOmpRpcChatHandbackListener('tab-1'))

    unmount()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when window.api.ompRpcChat is unavailable', () => {
    delete (window as unknown as { api?: unknown }).api
    expect(() => renderHook(() => useOmpRpcChatHandbackListener('tab-1'))).not.toThrow()
    expect(respawnPtyForOmpRpcChatHandback).not.toHaveBeenCalled()
  })

  // XLR-R8-001 (cross-lab review, round 8): main keeps the instruction until
  // this reports a respawn that actually happened, so every way out of a claim
  // has to report. Anything unreported leaves the lease held, and anything
  // wrongly reported as respawned loses the pane's only path back to a PTY.
  describe('settling the lease', () => {
    it('discards the instruction only once the respawn succeeded', async () => {
      claimPendingHandbacks.mockResolvedValue([lease('handback-1')])
      renderHook(() => useOmpRpcChatHandbackListener('tab-1'))
      await flush()

      expect(settleHandback).toHaveBeenCalledWith({
        paneKey: `tab-1:${LEAF_ID}`,
        token: 'handback-1',
        respawned: true
      })
    })

    it('hands the instruction back when the respawn failed', async () => {
      claimPendingHandbacks.mockResolvedValue([lease('handback-1')])
      respawnPtyForOmpRpcChatHandback.mockResolvedValue({
        ok: false,
        reason: 'spawn rejected'
      })
      renderHook(() => useOmpRpcChatHandbackListener('tab-1'))
      await flush()

      expect(settleHandback).toHaveBeenCalledWith({
        paneKey: `tab-1:${LEAF_ID}`,
        token: 'handback-1',
        respawned: false
      })
    })

    it('hands the instruction back when the respawn threw', async () => {
      claimPendingHandbacks.mockResolvedValue([lease('handback-1')])
      respawnPtyForOmpRpcChatHandback.mockRejectedValue(new Error('pty.spawn exploded'))
      renderHook(() => useOmpRpcChatHandbackListener('tab-1'))
      await flush()

      expect(settleHandback).toHaveBeenCalledWith({
        paneKey: `tab-1:${LEAF_ID}`,
        token: 'handback-1',
        respawned: false
      })
    })

    // Leaving Chat view unmounts panes; the claim it already sent still
    // resolves, and dropping it silently stranded the lease in main.
    it('hands the instruction back when it unmounted before the claim resolved', async () => {
      claimPendingHandbacks.mockResolvedValue([lease('handback-1')])
      const { unmount } = renderHook(() => useOmpRpcChatHandbackListener('tab-1'))

      unmount()
      await flush()

      expect(respawnPtyForOmpRpcChatHandback).not.toHaveBeenCalled()
      expect(settleHandback).toHaveBeenCalledWith({
        paneKey: `tab-1:${LEAF_ID}`,
        token: 'handback-1',
        respawned: false
      })
    })

    it('settles each leased pane under its own token', async () => {
      claimPendingHandbacks.mockResolvedValue([
        lease('handback-1'),
        lease('handback-2', { paneKey: `tab-1:${OTHER_LEAF_ID}` })
      ])
      renderHook(() => useOmpRpcChatHandbackListener('tab-1'))
      await flush()

      expect(settleHandback).toHaveBeenCalledTimes(2)
      expect(settleHandback).toHaveBeenCalledWith({
        paneKey: `tab-1:${OTHER_LEAF_ID}`,
        token: 'handback-2',
        respawned: true
      })
    })
  })
})
