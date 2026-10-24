import { describe, expect, it } from 'vitest'
import type { BrowserHistoryEntry } from '../../../../../shared/browser-workspace-types'
import {
  browserHistoryClearSince,
  groupBrowserHistoryRowsByDay,
  listBrowserHistoryRows
} from './browser-history-view-rows'

function entry(url: string, title: string, lastVisitedAt: number): BrowserHistoryEntry {
  return { url, normalizedUrl: url, title, lastVisitedAt, visitCount: 1 }
}

const at = (day: number, hour: number): number => new Date(2026, 9, day, hour).getTime()

describe('browser history view rows', () => {
  it('matches every word in the title or address, in any order', () => {
    const history = [
      entry('https://github.com/stablyai/orca', 'Orca repo', at(20, 9)),
      entry('https://en.wikipedia.org/wiki/Orca', 'Orca - Wikipedia', at(21, 9))
    ]
    expect(listBrowserHistoryRows(history, [], 'orca github').map((r) => r.title)).toEqual([
      'Orca repo'
    ])
    expect(listBrowserHistoryRows(history, [], '').map((r) => r.title)).toEqual([
      'Orca - Wikipedia',
      'Orca repo'
    ])
  })

  it('groups by the local day of the last visit, newest day first', () => {
    const rows = listBrowserHistoryRows(
      [
        entry('https://a.test', 'A', at(21, 23)),
        entry('https://b.test', 'B', at(22, 0)),
        entry('https://c.test', 'C', at(22, 8))
      ],
      [],
      ''
    )
    expect(groupBrowserHistoryRowsByDay(rows).map((day) => day.rows.map((r) => r.title))).toEqual([
      ['C', 'B'],
      ['A']
    ])
  })

  it('clears from an hour ago, from local midnight, or everything', () => {
    const now = at(22, 8)
    expect(browserHistoryClearSince('hour', now)).toBe(at(22, 7))
    expect(browserHistoryClearSince('today', now)).toBe(at(22, 0))
    expect(browserHistoryClearSince('all', now)).toBeUndefined()
  })
})
