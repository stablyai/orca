// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionConversationOutline } from '../../../../shared/agent-session-conversation-outline'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'

const mocks = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  readStructuredAgentSessionConversationOutline: mocks.read
}))

import {
  RAIL_OUTLINE_READ_RETRIES,
  RAIL_OUTLINE_READ_RETRY_BASE_MS,
  useStructuredAgentSessionRailOutline
} from './use-structured-agent-session-rail-outline'

const TARGET = { kind: 'local' } as const

function loaded(oldest: number): AgentJournalRenderItem[] {
  return [
    {
      itemId: `row-${oldest}`,
      revision: 1,
      sequence: oldest,
      observedAt: oldest,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'loaded' }] }
    }
  ]
}

function outline(through: number, epoch = 'epoch-1'): AgentSessionConversationOutline {
  return {
    sessionId: 'session-1',
    cursor: { epoch, sequence: through },
    entries: [
      { itemId: 'user-2', sequence: 2, preview: 'first prompt', imageCount: 0 },
      { itemId: 'user-7', sequence: 7, preview: '', imageCount: 1 }
    ],
    omittedEntries: 0
  }
}

type Props = { epoch: string; oldest: number; hasOlder: boolean; enabled: boolean }

function renderOutline(initialProps: Props) {
  return renderHook(
    ({ epoch, oldest, hasOlder, enabled }: Props) =>
      useStructuredAgentSessionRailOutline({
        sessionId: 'session-1',
        target: TARGET,
        state: { epoch, items: loaded(oldest), hasOlder },
        enabled
      }),
    { initialProps }
  )
}

const VISIBLE: Props = { epoch: 'epoch-1', oldest: 50, hasOlder: true, enabled: true }

describe('structured rail outline fetch', () => {
  beforeEach(() => {
    mocks.read.mockReset()
  })

  it('never asks when every message is already loaded', () => {
    const { result } = renderOutline({ ...VISIBLE, hasOlder: false })
    expect(result.current).toBeNull()
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('never asks from a hidden pane', () => {
    renderOutline({ ...VISIBLE, enabled: false })
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('maps the unloaded messages once the outline arrives', async () => {
    mocks.read.mockResolvedValue(outline(120))
    const { result } = renderOutline(VISIBLE)
    await waitFor(() =>
      expect(result.current).toEqual([
        { id: 'user-2', text: 'first prompt', hasImages: false },
        { id: 'user-7', text: '', hasImages: true }
      ])
    )
    expect(mocks.read).toHaveBeenCalledWith(TARGET, 'session-1')
  })

  it('leaves the rail on loaded messages against a host without the outline', async () => {
    mocks.read.mockResolvedValue(null)
    const { result, rerender } = renderOutline(VISIBLE)
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1))
    // A live stream keeps moving the window; that is not a reason to ask again.
    for (let oldest = 51; oldest < 80; oldest += 1) {
      rerender({ ...VISIBLE, oldest })
    }
    expect(result.current).toBeNull()
    expect(mocks.read).toHaveBeenCalledTimes(1)
  })

  it('asks again only when the loaded window trims past what the outline covers', async () => {
    mocks.read.mockResolvedValue(outline(60))
    const { result, rerender } = renderOutline(VISIBLE)
    await waitFor(() => expect(result.current).not.toBeNull())
    // Still abutting the outline: fresh, no request.
    rerender({ ...VISIBLE, oldest: 61 })
    expect(mocks.read).toHaveBeenCalledTimes(1)
    expect(result.current).not.toBeNull()
    // A gap opens at 61: stale, so the rail falls back and one new read goes out.
    mocks.read.mockResolvedValue(outline(200))
    rerender({ ...VISIBLE, oldest: 62 })
    expect(result.current).toBeNull()
    await waitFor(() => expect(result.current).not.toBeNull())
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })

  it('asks again after the journal epoch changes', async () => {
    mocks.read.mockResolvedValue(outline(120))
    const { result, rerender } = renderOutline(VISIBLE)
    await waitFor(() => expect(result.current).not.toBeNull())
    mocks.read.mockResolvedValue(outline(30, 'epoch-2'))
    rerender({ ...VISIBLE, epoch: 'epoch-2', oldest: 5 })
    expect(result.current).toBeNull()
    await waitFor(() =>
      expect(result.current).toEqual([{ id: 'user-2', text: 'first prompt', hasImages: false }])
    )
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })

  describe('after a failed read', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('retries with backoff until a read lands', async () => {
      mocks.read
        .mockRejectedValueOnce(new Error('offline'))
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue(outline(120))
      const { result } = renderOutline(VISIBLE)
      await act(async () => {})
      expect(mocks.read).toHaveBeenCalledTimes(1)
      expect(result.current).toBeNull()

      await act(async () => vi.advanceTimersByTimeAsync(RAIL_OUTLINE_READ_RETRY_BASE_MS))
      expect(mocks.read).toHaveBeenCalledTimes(2)
      // Backing off: the second retry waits twice as long.
      await act(async () => vi.advanceTimersByTimeAsync(RAIL_OUTLINE_READ_RETRY_BASE_MS))
      expect(mocks.read).toHaveBeenCalledTimes(2)
      await act(async () => vi.advanceTimersByTimeAsync(RAIL_OUTLINE_READ_RETRY_BASE_MS))
      expect(mocks.read).toHaveBeenCalledTimes(3)
      expect(result.current).toEqual([
        { id: 'user-2', text: 'first prompt', hasImages: false },
        { id: 'user-7', text: '', hasImages: true }
      ])
    })

    it('gives up after a few retries', async () => {
      mocks.read.mockRejectedValue(new Error('offline'))
      const { result } = renderOutline(VISIBLE)
      for (let minute = 0; minute < 10; minute += 1) {
        await act(async () => vi.advanceTimersByTimeAsync(60_000))
      }
      expect(mocks.read).toHaveBeenCalledTimes(1 + RAIL_OUTLINE_READ_RETRIES)
      expect(result.current).toBeNull()
    })

    it('never retries a host without the outline', async () => {
      mocks.read.mockResolvedValue(null)
      renderOutline(VISIBLE)
      for (let minute = 0; minute < 10; minute += 1) {
        await act(async () => vi.advanceTimersByTimeAsync(60_000))
      }
      expect(mocks.read).toHaveBeenCalledTimes(1)
    })
  })
})
