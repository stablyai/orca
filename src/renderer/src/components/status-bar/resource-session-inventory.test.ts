import { describe, expect, it } from 'vitest'
import {
  EMPTY_DAEMON_SESSION_INVENTORY,
  EMPTY_DAEMON_SESSION_ROWS,
  ResourceSessionInventoryRows
} from './resource-session-inventory'
import type { DaemonSession } from './resource-usage-merge-types'

function session(id: string): DaemonSession {
  return { id, cwd: '/workspace', title: id, agentOwnership: 'absent' as const }
}

describe('resource session inventory rows', () => {
  it('replaces rows with a detached session-id index', () => {
    const source = [session('a'), session('b')]
    const rows = new ResourceSessionInventoryRows()
    rows.replace(source)
    source.pop()

    expect(rows.toArray()).toEqual([session('a'), session('b')])
  })

  it('removes one or many rows by session id', () => {
    const rows = new ResourceSessionInventoryRows()
    rows.replace([session('live'), session('orphan'), session('other')])

    expect(rows.remove('orphan')).toBe(true)
    expect(rows.toArray().map(({ id }) => id)).toEqual(['live', 'other'])
    expect(rows.removeMany(new Set(['live', 'missing', 'other']))).toBe(2)
    expect(rows.toArray()).toEqual([])
  })

  it('does not report row changes for absent ids', () => {
    const rows = new ResourceSessionInventoryRows()
    rows.replace([session('live')])

    expect(rows.remove('gone')).toBe(false)
    expect(rows.removeMany(new Set())).toBe(0)
    expect(rows.toArray()).toEqual([session('live')])
  })

  it('shares the allocation-free closed inventory rows', () => {
    expect(EMPTY_DAEMON_SESSION_INVENTORY.sessions).toBe(EMPTY_DAEMON_SESSION_ROWS)
    expect(EMPTY_DAEMON_SESSION_INVENTORY.count).toBe(0)
  })
})
