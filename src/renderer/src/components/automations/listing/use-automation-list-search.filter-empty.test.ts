// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { makeAutomation, makeAutomationListRow } from '../automations-page-fixtures'
import { automationListBotHost } from './automation-list-bot-host'
import { botListFilter } from './automation-list-view'
import {
  offersAutomationTemplates,
  resolveAutomationListEmptyState
} from './automation-list-empty-state'
import { useAutomationListSearch } from './use-automation-list-search'

const rows = ['a', 'b', 'c'].map((id) =>
  makeAutomationListRow({
    automation: makeAutomation({ id, name: `Fixture ${id}`, workspaceId: 'folder:other' })
  })
)

describe('a filter that matches nothing on a host that has automations', () => {
  it('says the filter emptied the list, not that there are no automations', () => {
    const { result } = renderHook(() =>
      useAutomationListSearch({
        listSearchQuery: '',
        listFilter: botListFilter({
          workspaceId: 'folder:fixture-bot',
          name: 'Fixture Bot',
          hostId: 'local'
        }),
        botHost: automationListBotHost('local', null),
        rows,
        externalAutomationEntries: [],
        repoMap: new Map(),
        selectedRowKey: null,
        selectedExternalKey: null,
        selectAutomationRow: () => {},
        selectExternalKey: () => {}
      })
    )
    const { filteredRows, hasListItems, searchCounts } = result.current
    expect(filteredRows).toEqual([])
    // The host has rows: a held refresh must keep the toolbar and the clearable pill, not the skeleton.
    expect(hasListItems).toBe(true)
    const state = resolveAutomationListEmptyState({
      resolution: {
        effective: { kind: 'all' },
        entry: null,
        status: 'ready',
        announceFallback: false
      },
      ...searchCounts,
      filterActive: true
    })
    expect(state.kind).toBe('search-no-match')
    expect(state.title).toBe('No automations match your filters')
    // No starter templates under the pill: the host has automations, the filter hid them.
    expect(offersAutomationTemplates(state, hasListItems)).toBe(false)
  })
})
