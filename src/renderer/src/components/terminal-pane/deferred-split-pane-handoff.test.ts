import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  PTY_PRECONNECT_INPUT_MAX_CODE_UNITS,
  PTY_PRECONNECT_INPUT_MAX_ENTRIES
} from './pty-preconnect-input-buffer'
import {
  appendDeferredSplitPaneInput,
  beginDeferredSplitPaneHandoff,
  claimDeferredSplitPaneHandoff,
  clearDeferredSplitPaneHandoff,
  DEFERRED_SPLIT_PANE_HANDOFF_MAX_RECORDS,
  DEFERRED_SPLIT_PANE_HANDOFF_TTL_MS,
  discardDeferredSplitPaneHandoffForKey,
  discardDeferredSplitPaneHandoffsForTab,
  getDeferredSplitPaneHandoffCountForTests,
  releaseDeferredSplitPaneHandoff,
  resetDeferredSplitPaneHandoffsForTests
} from './deferred-split-pane-handoff'

const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'

describe('deferred split pane handoff', () => {
  beforeEach(resetDeferredSplitPaneHandoffsForTests)
  afterEach(resetDeferredSplitPaneHandoffsForTests)

  it('hands the same cwd promise and buffered input to a remounted leaf in order', () => {
    const key = makePaneKey('tab-1', LEAF_1)
    const cwdPromise = Promise.resolve('/source/cwd')
    const initial = beginDeferredSplitPaneHandoff(key, cwdPromise)

    appendDeferredSplitPaneInput(initial, { data: 'typed', kind: 'ordinary' })
    appendDeferredSplitPaneInput(initial, { data: '\x1b[0n', kind: 'immediate' })
    appendDeferredSplitPaneInput(initial, { data: '\x03', kind: 'accepted' })

    const remounted = claimDeferredSplitPaneHandoff(key)

    expect(remounted?.cwdPromise).toBe(cwdPromise)
    expect(remounted?.preconnectInput).toEqual([
      { data: 'typed', kind: 'ordinary' },
      { data: '\x1b[0n', kind: 'immediate' },
      { data: '\x03', kind: 'accepted' }
    ])
  })

  it('keeps input across repeated remounts and fences stale owners', () => {
    const key = makePaneKey('tab-1', LEAF_1)
    const initial = beginDeferredSplitPaneHandoff(key, Promise.resolve('/source/cwd'))
    appendDeferredSplitPaneInput(initial, { data: 'before-first-remount', kind: 'ordinary' })
    const firstRemount = claimDeferredSplitPaneHandoff(key)
    expect(firstRemount).not.toBeNull()

    appendDeferredSplitPaneInput(initial, { data: 'stale-input', kind: 'ordinary' })
    clearDeferredSplitPaneHandoff(initial)
    clearDeferredSplitPaneHandoff(initial)
    appendDeferredSplitPaneInput(firstRemount!.handle, {
      data: 'before-second-remount',
      kind: 'ordinary'
    })

    const secondRemount = claimDeferredSplitPaneHandoff(key)
    expect(secondRemount?.preconnectInput).toEqual([
      { data: 'before-first-remount', kind: 'ordinary' },
      { data: 'before-second-remount', kind: 'ordinary' }
    ])

    clearDeferredSplitPaneHandoff(firstRemount!.handle)
    expect(getDeferredSplitPaneHandoffCountForTests()).toBe(1)
    clearDeferredSplitPaneHandoff(secondRemount!.handle)
    expect(getDeferredSplitPaneHandoffCountForTests()).toBe(0)
  })

  it('releases an unmounted owner without dropping its pending handoff', () => {
    const key = makePaneKey('tab-1', LEAF_1)
    const initial = beginDeferredSplitPaneHandoff(key, Promise.resolve('/source/cwd'))
    appendDeferredSplitPaneInput(initial, { data: 'before-unmount', kind: 'ordinary' })

    releaseDeferredSplitPaneHandoff(initial)
    appendDeferredSplitPaneInput(initial, { data: 'late-stale', kind: 'ordinary' })
    clearDeferredSplitPaneHandoff(initial)

    expect(claimDeferredSplitPaneHandoff(key)?.preconnectInput).toEqual([
      { data: 'before-unmount', kind: 'ordinary' }
    ])
  })

  it('lets a late close discard a released handoff by its stable pane key', () => {
    const key = makePaneKey('tab-1', LEAF_1)
    const owner = beginDeferredSplitPaneHandoff(key, Promise.resolve('/source/cwd'))
    appendDeferredSplitPaneInput(owner, { data: 'must-not-replay', kind: 'ordinary' })

    // Whole-tab cleanup releases the mount-local handle before a stale close callback can run.
    releaseDeferredSplitPaneHandoff(owner)
    discardDeferredSplitPaneHandoffForKey(key)

    expect(claimDeferredSplitPaneHandoff(key)).toBeNull()
  })

  it('clears or discards only the current owner', () => {
    const clearedKey = makePaneKey('tab-clear', LEAF_1)
    const cleared = beginDeferredSplitPaneHandoff(clearedKey, Promise.resolve('/clear'))
    clearDeferredSplitPaneHandoff(cleared)
    expect(claimDeferredSplitPaneHandoff(clearedKey)).toBeNull()

    const discardedKey = makePaneKey('tab-discard', LEAF_1)
    const discarded = beginDeferredSplitPaneHandoff(discardedKey, Promise.resolve('/discard'))
    clearDeferredSplitPaneHandoff(discarded)
    expect(claimDeferredSplitPaneHandoff(discardedKey)).toBeNull()
  })

  it('drops a stale record when an authoritative restored PTY wins the key', () => {
    const key = makePaneKey('tab-authoritative', LEAF_1)
    const stale = beginDeferredSplitPaneHandoff(key, Promise.resolve('/stale'))
    appendDeferredSplitPaneInput(stale, { data: 'must-not-replay', kind: 'ordinary' })

    discardDeferredSplitPaneHandoffForKey(key)

    expect(claimDeferredSplitPaneHandoff(key)).toBeNull()
    expect(getDeferredSplitPaneHandoffCountForTests()).toBe(0)
  })

  it('replaces an older handoff for the same stable pane key', () => {
    const key = makePaneKey('tab-1', LEAF_1)
    const stale = beginDeferredSplitPaneHandoff(key, Promise.resolve('/stale'))
    appendDeferredSplitPaneInput(stale, { data: 'stale', kind: 'ordinary' })
    const currentPromise = Promise.resolve('/current')
    const current = beginDeferredSplitPaneHandoff(key, currentPromise)

    appendDeferredSplitPaneInput(stale, { data: 'late-stale', kind: 'ordinary' })
    clearDeferredSplitPaneHandoff(stale)
    appendDeferredSplitPaneInput(current, { data: 'current', kind: 'ordinary' })

    const claimed = claimDeferredSplitPaneHandoff(key)
    expect(claimed?.cwdPromise).toBe(currentPromise)
    expect(claimed?.preconnectInput).toEqual([{ data: 'current', kind: 'ordinary' }])
  })

  it('retains input within the shared preconnect entry and code-unit caps', () => {
    const entryKey = makePaneKey('tab-entries', LEAF_1)
    const entryHandle = beginDeferredSplitPaneHandoff(entryKey, Promise.resolve('/entries'))
    for (let index = 0; index < PTY_PRECONNECT_INPUT_MAX_ENTRIES; index += 1) {
      appendDeferredSplitPaneInput(entryHandle, { data: '', kind: 'ordinary' })
    }
    appendDeferredSplitPaneInput(entryHandle, { data: 'overflow', kind: 'ordinary' })
    expect(claimDeferredSplitPaneHandoff(entryKey)?.preconnectInput).toHaveLength(
      PTY_PRECONNECT_INPUT_MAX_ENTRIES
    )

    const codeUnitKey = makePaneKey('tab-code-units', LEAF_1)
    const codeUnitHandle = beginDeferredSplitPaneHandoff(
      codeUnitKey,
      Promise.resolve('/code-units')
    )
    appendDeferredSplitPaneInput(codeUnitHandle, {
      data: 'x'.repeat(PTY_PRECONNECT_INPUT_MAX_CODE_UNITS),
      kind: 'ordinary'
    })
    appendDeferredSplitPaneInput(codeUnitHandle, { data: 'overflow', kind: 'ordinary' })
    expect(claimDeferredSplitPaneHandoff(codeUnitKey)?.preconnectInput).toEqual([
      { data: 'x'.repeat(PTY_PRECONNECT_INPUT_MAX_CODE_UNITS), kind: 'ordinary' }
    ])
  })

  it('discards every handoff for one tab without touching another tab', () => {
    const firstKey = makePaneKey('tab-1', LEAF_1)
    const secondKey = makePaneKey('tab-1', LEAF_2)
    const otherKey = makePaneKey('tab-2', LEAF_1)
    beginDeferredSplitPaneHandoff(firstKey, Promise.resolve('/first'))
    beginDeferredSplitPaneHandoff(secondKey, Promise.resolve('/second'))
    beginDeferredSplitPaneHandoff(otherKey, Promise.resolve('/other'))

    discardDeferredSplitPaneHandoffsForTab('tab-1')

    expect(claimDeferredSplitPaneHandoff(firstKey)).toBeNull()
    expect(claimDeferredSplitPaneHandoff(secondKey)).toBeNull()
    expect(claimDeferredSplitPaneHandoff(otherKey)).not.toBeNull()
  })

  it('evicts the oldest handoff when the record cap is reached', () => {
    const keys = Array.from({ length: DEFERRED_SPLIT_PANE_HANDOFF_MAX_RECORDS + 1 }, (_, index) =>
      makePaneKey(`tab-${index}`, LEAF_1)
    )
    for (const key of keys) {
      beginDeferredSplitPaneHandoff(key, Promise.resolve('/source/cwd'))
    }

    expect(getDeferredSplitPaneHandoffCountForTests()).toBe(DEFERRED_SPLIT_PANE_HANDOFF_MAX_RECORDS)
    expect(claimDeferredSplitPaneHandoff(keys[0])).toBeNull()
    expect(claimDeferredSplitPaneHandoff(keys.at(-1)!)).not.toBeNull()
  })

  it('expires an abandoned handoff after the bounded remount window', () => {
    vi.useFakeTimers()
    try {
      const key = makePaneKey('tab-1', LEAF_1)
      beginDeferredSplitPaneHandoff(key, Promise.resolve('/source/cwd'))
      expect(getDeferredSplitPaneHandoffCountForTests()).toBe(1)

      vi.advanceTimersByTime(DEFERRED_SPLIT_PANE_HANDOFF_TTL_MS)

      expect(getDeferredSplitPaneHandoffCountForTests()).toBe(0)
      expect(claimDeferredSplitPaneHandoff(key)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not expose the registry input array by reference', () => {
    const key = makePaneKey('tab-1', LEAF_1)
    const handle = beginDeferredSplitPaneHandoff(key, Promise.resolve('/source/cwd'))
    appendDeferredSplitPaneInput(handle, { data: 'kept', kind: 'ordinary' })
    const firstClaim = claimDeferredSplitPaneHandoff(key)
    firstClaim?.preconnectInput.splice(0)

    expect(claimDeferredSplitPaneHandoff(key)?.preconnectInput).toEqual([
      { data: 'kept', kind: 'ordinary' }
    ])
  })
})
