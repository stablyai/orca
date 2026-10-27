import { describe, expect, it } from 'vitest'
import {
  RECENTLY_RETIRED_AGENT_STATUS_PANE_KEYS_MAX,
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
