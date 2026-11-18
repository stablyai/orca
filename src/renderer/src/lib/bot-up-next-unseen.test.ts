// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./bot-host-per-bot-read', () => ({
  createBotHostUnseenCounts: () => ({
    useCount: () => 2,
    read: async () => {}
  })
}))
vi.mock('./bot-hosts', () => ({ callBotRpc: vi.fn() }))

import { useBotPanelFold } from '@/components/bots/use-bot-panel-fold'
import { useBotUpNextUnseen } from './bot-up-next-unseen'

const BOT = { id: 'bot-1', hostId: 'local' as const }

beforeEach(() => window.localStorage.clear())
// Folds are read again from storage once no row shows them.
afterEach(cleanup)

describe('useBotUpNextUnseen', () => {
  it('stops counting while Suggestions stay folded, and counts again once opened', () => {
    const { result } = renderHook(() => ({
      unseen: useBotUpNextUnseen(BOT),
      fold: useBotPanelFold(BOT.id, 'suggestions')
    }))
    expect(result.current.unseen).toBe(2)

    act(() => result.current.fold.onOpenChange(false))
    expect(result.current.unseen).toBe(0)

    act(() => result.current.fold.onOpenChange(true))
    expect(result.current.unseen).toBe(2)
  })

  it("leaves other bots' counts alone and reads a fold saved before", () => {
    window.localStorage.setItem('orca.bots.panelFolds', JSON.stringify({ other: ['suggestions'] }))
    const first = renderHook(() => useBotUpNextUnseen(BOT))
    expect(first.result.current).toBe(2)
    first.unmount()

    window.localStorage.setItem(
      'orca.bots.panelFolds',
      JSON.stringify({ 'bot-1': ['suggestions'] })
    )
    expect(renderHook(() => useBotUpNextUnseen(BOT)).result.current).toBe(0)
  })
})
