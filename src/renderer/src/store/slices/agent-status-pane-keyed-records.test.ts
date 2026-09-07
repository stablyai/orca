import { describe, expect, it } from 'vitest'
import {
  RECENTLY_CLOSED_AGENT_STATUS_TAB_IDS_MAX,
  RECENTLY_RETIRED_AGENT_STATUS_PANE_KEYS_MAX,
  boundRecentlyClosedAgentStatusTabIds,
  boundRecentlyRetiredAgentStatusPaneKeys
} from './agent-status-pane-keyed-records'

function keyRecord(keys: readonly string[]): Record<string, true> {
  const record: Record<string, true> = {}
  for (const key of keys) {
    record[key] = true
  }
  return record
}

function fullRecord(max: number, prefix: string): Record<string, true> {
  return keyRecord(Array.from({ length: max }, (_, i) => `${prefix}${i}`))
}

describe('boundRecentlyRetiredAgentStatusPaneKeys', () => {
  it('returns the existing record when there is nothing to add', () => {
    const existing = keyRecord(['a', 'b'])
    expect(boundRecentlyRetiredAgentStatusPaneKeys(existing, [])).toBe(existing)
    const empty = keyRecord([])
    expect(boundRecentlyRetiredAgentStatusPaneKeys(empty, [])).toBe(empty)
  })

  it('returns the existing record when the additions already form its tail in order', () => {
    const existing = keyRecord(['a', 'b', 'c'])
    expect(boundRecentlyRetiredAgentStatusPaneKeys(existing, ['c'])).toBe(existing)
    expect(boundRecentlyRetiredAgentStatusPaneKeys(existing, ['b', 'c'])).toBe(existing)
    expect(boundRecentlyRetiredAgentStatusPaneKeys(existing, ['a', 'b', 'c'])).toBe(existing)
  })

  // Why: LRU order decides which key the cap evicts next. A key-set match is not a
  // no-op when the re-added key is not already at the tail — it must move there.
  it('re-retiring an existing non-tail key changes identity and moves it to the tail', () => {
    const existing = keyRecord(['a', 'b', 'c'])
    const next = boundRecentlyRetiredAgentStatusPaneKeys(existing, ['a'])
    expect(next).not.toBe(existing)
    expect(Object.keys(next)).toEqual(['b', 'c', 'a'])
    expect(Object.keys(existing)).toEqual(['a', 'b', 'c'])
  })

  it('tail keys re-added in a different relative order are rebuilt in the new order', () => {
    const existing = keyRecord(['a', 'b', 'c'])
    const next = boundRecentlyRetiredAgentStatusPaneKeys(existing, ['c', 'b'])
    expect(next).not.toBe(existing)
    expect(Object.keys(next)).toEqual(['a', 'c', 'b'])
  })

  it('appends new keys after the existing ones', () => {
    const existing = keyRecord(['a'])
    const next = boundRecentlyRetiredAgentStatusPaneKeys(existing, ['b', 'c'])
    expect(next).not.toBe(existing)
    expect(Object.keys(next)).toEqual(['a', 'b', 'c'])
  })

  it('evicts the oldest keys once the cap is exceeded', () => {
    const full = fullRecord(RECENTLY_RETIRED_AGENT_STATUS_PANE_KEYS_MAX, 'k')
    const next = boundRecentlyRetiredAgentStatusPaneKeys(full, ['fresh'])
    const keys = Object.keys(next)
    expect(keys).toHaveLength(RECENTLY_RETIRED_AGENT_STATUS_PANE_KEYS_MAX)
    expect(keys[0]).toBe('k1')
    expect(keys.at(-1)).toBe('fresh')
    expect(next.k0).toBeUndefined()
  })

  it('re-retiring the oldest key at the cap keeps it fenced and evicts the next oldest', () => {
    const full = fullRecord(RECENTLY_RETIRED_AGENT_STATUS_PANE_KEYS_MAX, 'k')
    const bumped = boundRecentlyRetiredAgentStatusPaneKeys(full, ['k0'])
    expect(bumped).not.toBe(full)
    expect(Object.keys(bumped).at(-1)).toBe('k0')
    const afterFresh = boundRecentlyRetiredAgentStatusPaneKeys(bumped, ['fresh'])
    expect(afterFresh.k0).toBe(true)
    expect(afterFresh.k1).toBeUndefined()
  })

  it('never returns an over-cap record unchanged', () => {
    const over = fullRecord(RECENTLY_RETIRED_AGENT_STATUS_PANE_KEYS_MAX + 1, 'k')
    const last = `k${RECENTLY_RETIRED_AGENT_STATUS_PANE_KEYS_MAX}`
    const next = boundRecentlyRetiredAgentStatusPaneKeys(over, [last])
    expect(next).not.toBe(over)
    expect(Object.keys(next)).toHaveLength(RECENTLY_RETIRED_AGENT_STATUS_PANE_KEYS_MAX)
    expect(next.k0).toBeUndefined()
  })
})

describe('boundRecentlyClosedAgentStatusTabIds', () => {
  it('returns the existing record when the tab is already the most recent', () => {
    const existing = keyRecord(['t1', 't2'])
    expect(boundRecentlyClosedAgentStatusTabIds(existing, 't2')).toBe(existing)
  })

  it('moves a re-closed tab to the tail', () => {
    const existing = keyRecord(['t1', 't2'])
    const next = boundRecentlyClosedAgentStatusTabIds(existing, 't1')
    expect(next).not.toBe(existing)
    expect(Object.keys(next)).toEqual(['t2', 't1'])
  })

  it('evicts the oldest tab once the cap is exceeded', () => {
    const full = fullRecord(RECENTLY_CLOSED_AGENT_STATUS_TAB_IDS_MAX, 't')
    const next = boundRecentlyClosedAgentStatusTabIds(full, 'fresh')
    expect(Object.keys(next)).toHaveLength(RECENTLY_CLOSED_AGENT_STATUS_TAB_IDS_MAX)
    expect(next.t0).toBeUndefined()
    expect(next.fresh).toBe(true)
  })
})
