import { describe, expect, it } from 'vitest'
import {
  EMPTY_DAEMON_SESSION_INVENTORY,
  inventoryFromSessionIds,
  inventoryFromSessions,
  removeSessionFromInventory,
  removeSessionsFromInventory
} from './resource-session-inventory'
import type { DaemonSession } from './resource-usage-merge-types'

function session(id: string): DaemonSession {
  return { id, cwd: '/workspace', title: id }
}

describe('resource session inventory', () => {
  it('builds count from daemon listSessions payloads', () => {
    const inventory = inventoryFromSessions([session('a'), session('b'), session('a')])
    expect(inventory.count).toBe(2)
    expect(inventory.sessionIds).toEqual(['a', 'b'])
    expect(inventory.sessions.map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('builds a detail-free count from unique session IDs', () => {
    expect(inventoryFromSessionIds(['a', 'b', 'a'])).toEqual({
      sessionIds: ['a', 'b'],
      sessions: [],
      count: 2
    })
  })

  it('returns a detached sessions array so callers can mutate safely', () => {
    const source = [session('a')]
    const inventory = inventoryFromSessions(source)
    source.pop()
    expect(inventory.sessions).toEqual([session('a')])
    expect(inventory.count).toBe(1)
  })

  it('removes killed or exited sessions without inventing wake-hint ids', () => {
    const start = inventoryFromSessions([session('live'), session('orphan'), session('other')])
    const afterOne = removeSessionFromInventory(start, 'orphan')
    expect(afterOne.count).toBe(2)
    expect(afterOne.sessionIds).toEqual(['live', 'other'])
    expect(afterOne.sessions.map((entry) => entry.id)).toEqual(['live', 'other'])

    const afterMany = removeSessionsFromInventory(start, new Set(['live', 'missing', 'other']))
    expect(afterMany).toEqual(inventoryFromSessions([session('orphan')]))
  })

  it('removes sessions from a detail-free ID inventory', () => {
    const start = inventoryFromSessionIds(['live', 'exited'])
    expect(removeSessionFromInventory(start, 'exited')).toEqual(inventoryFromSessionIds(['live']))
  })

  it('is a no-op when removed ids are absent', () => {
    const start = inventoryFromSessions([session('live')])
    expect(removeSessionFromInventory(start, 'gone')).toBe(start)
    expect(removeSessionsFromInventory(start, new Set())).toBe(start)
    expect(EMPTY_DAEMON_SESSION_INVENTORY.count).toBe(0)
  })
})
