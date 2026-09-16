import { describe, expect, it } from 'vitest'
import {
  RECENTLY_CLOSED_AGENT_STATUS_TAB_IDS_MAX,
  RECENTLY_RETIRED_AGENT_STATUS_PANE_KEYS_MAX,
  boundRecentlyClosedAgentStatusTabIds,
  boundRecentlyRetiredAgentStatusPaneKeys,
  removePaneKeys
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

it('does not enumerate unrelated pane records when removing absent keys', () => {
  let enumerations = 0
  const record = new Proxy(
    Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`tab-${index}:leaf`, index])),
    {
      ownKeys(target) {
        enumerations += 1
        return Reflect.ownKeys(target)
      }
    }
  )
  for (let index = 0; index < 200; index += 1) {
    expect(removePaneKeys(record, new Set(['absent:leaf']))).toBe(record)
  }
  expect(enumerations).toBe(0)
})

it('removes enumerable undefined values without removing inherited or hidden keys', () => {
  const record = { visible: undefined }
  Object.defineProperty(record, 'hidden', { value: 1, enumerable: false })
  expect(removePaneKeys(record, new Set(['hidden', 'toString']))).toBe(record)
  expect(Object.hasOwn(removePaneKeys(record, new Set(['visible'])), 'visible')).toBe(false)
})

// Probing the requested keys only matches the old record-enumeration when the two sets
// disagree in both directions, and the store relies on the unchanged case staying identical.
it('drops every requested key that is present and keeps the reference when none are', () => {
  const base = { a: 1, b: 2, c: 3 }
  expect(removePaneKeys({ ...base }, new Set(['a', 'b', 'c', 'd', 'e']))).toEqual({})
  expect(removePaneKeys({ ...base }, new Set(['b', 'missing']))).toEqual({ a: 1, c: 3 })
  const disjoint = { ...base }
  expect(removePaneKeys(disjoint, new Set(['x', 'y']))).toBe(disjoint)
  const noKeys = { ...base }
  expect(removePaneKeys(noKeys, new Set())).toBe(noKeys)
  const empty = {}
  expect(removePaneKeys(empty, new Set(['a']))).toBe(empty)
})

it('leaves surviving keys in their original order and does not pollute the prototype', () => {
  const record: Record<string, number> = { z: 1, y: 2, x: 3, w: 4 }
  expect(Object.keys(removePaneKeys(record, new Set(['x', 'z'])))).toEqual(['y', 'w'])
  const plain = { safe: 1 }
  expect(removePaneKeys(plain, new Set(['__proto__', 'constructor']))).toBe(plain)
  expect(Object.getPrototypeOf(plain)).toBe(Object.prototype)
})
