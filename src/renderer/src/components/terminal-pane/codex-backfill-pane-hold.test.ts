// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexBackfillPaneHoldState } from '../../../../shared/codex-backfill-status-types'
import { subscribeToCodexBackfillPaneHold } from './codex-backfill-pane-hold'

describe('subscribeToCodexBackfillPaneHold', () => {
  let listeners: ((state: CodexBackfillPaneHoldState) => void)[]
  let initial: CodexBackfillPaneHoldState | null
  let unsubscribeSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    listeners = []
    initial = null
    unsubscribeSpy = vi.fn()
    ;(window as never as { api: unknown }).api = {
      codexBackfill: {
        paneHoldStatus: vi.fn(() => Promise.resolve(initial)),
        onPaneHoldChanged: (cb: (state: CodexBackfillPaneHoldState) => void) => {
          listeners.push(cb)
          return unsubscribeSpy
        }
      }
    }
  })
  afterEach(() => {
    delete (window as never as { api?: unknown }).api
  })

  const emit = (state: CodexBackfillPaneHoldState): void => listeners.forEach((cb) => cb(state))

  it('replays the current hold state for its paneKey on subscribe', async () => {
    initial = { paneKey: 'p1', phase: 'indexing', lastWatermark: 'sessions/a.jsonl' }
    const onState = vi.fn()
    subscribeToCodexBackfillPaneHold('p1', onState)
    await Promise.resolve()
    await Promise.resolve()
    expect(onState).toHaveBeenCalledWith({ lastWatermark: 'sessions/a.jsonl' })
  })

  it('maps pushed indexing state and clears on launched', () => {
    const onState = vi.fn()
    subscribeToCodexBackfillPaneHold('p1', onState)
    emit({ paneKey: 'p1', phase: 'indexing', lastWatermark: 'sessions/b.jsonl' })
    expect(onState).toHaveBeenLastCalledWith({ lastWatermark: 'sessions/b.jsonl' })
    emit({ paneKey: 'p1', phase: 'launched', lastWatermark: null })
    expect(onState).toHaveBeenLastCalledWith(null)
  })

  it('ignores other panes', () => {
    const onState = vi.fn()
    subscribeToCodexBackfillPaneHold('p1', onState)
    emit({ paneKey: 'other', phase: 'indexing', lastWatermark: null })
    expect(onState).not.toHaveBeenCalled()
  })

  it('stops delivering after dispose and forwards the unsubscribe', () => {
    const onState = vi.fn()
    const dispose = subscribeToCodexBackfillPaneHold('p1', onState)
    dispose()
    emit({ paneKey: 'p1', phase: 'indexing', lastWatermark: null })
    expect(onState).not.toHaveBeenCalled()
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when the api surface is missing (web build)', () => {
    ;(window as never as { api?: unknown }).api = {}
    expect(() => subscribeToCodexBackfillPaneHold('p1', vi.fn())()).not.toThrow()
  })
})
