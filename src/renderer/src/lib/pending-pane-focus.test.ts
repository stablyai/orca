import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FocusTerminalPaneDetail } from '@/constants/terminal'
import {
  clearPendingPaneFocus,
  consumePendingPaneFocus,
  queuePaneFocus
} from './pending-pane-focus'

const DETAIL: FocusTerminalPaneDetail = { tabId: 'tab-1', leafId: 'leaf-1' }

describe('pending-pane-focus', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    clearPendingPaneFocus('tab-1')
    clearPendingPaneFocus('tab-2')
  })

  it('consumes a queued focus detail for the matching tab', () => {
    queuePaneFocus('tab-1', DETAIL)
    expect(consumePendingPaneFocus('tab-1')).toEqual(DETAIL)
  })

  it('returns null for a tab with no queued focus', () => {
    queuePaneFocus('tab-1', DETAIL)
    expect(consumePendingPaneFocus('tab-2')).toBeNull()
  })

  it('drains on consume so a second consume returns null', () => {
    queuePaneFocus('tab-1', DETAIL)
    consumePendingPaneFocus('tab-1')
    expect(consumePendingPaneFocus('tab-1')).toBeNull()
  })

  it('clears a queued focus without consuming it', () => {
    queuePaneFocus('tab-1', DETAIL)
    clearPendingPaneFocus('tab-1')
    expect(consumePendingPaneFocus('tab-1')).toBeNull()
  })

  it('expires a focus parked longer than the TTL', () => {
    queuePaneFocus('tab-1', DETAIL)
    vi.advanceTimersByTime(15_001)
    expect(consumePendingPaneFocus('tab-1')).toBeNull()
  })

  it('replaces an older queued focus for the same tab', () => {
    const newer: FocusTerminalPaneDetail = { tabId: 'tab-1', leafId: 'leaf-2' }
    queuePaneFocus('tab-1', DETAIL)
    queuePaneFocus('tab-1', newer)
    expect(consumePendingPaneFocus('tab-1')).toEqual(newer)
  })
})
