import { describe, expect, it } from 'vitest'
import {
  closeTab,
  DB_QUERY_TAB_ID,
  defaultWorkspaceTabs,
  openTableTab,
  setActiveTab
} from './database-workspace-tabs'

describe('database workspace tabs', () => {
  it('defaults to a single permanent Query tab', () => {
    const ws = defaultWorkspaceTabs()
    expect(ws.tabs).toEqual([{ tabId: DB_QUERY_TAB_ID, kind: 'query' }])
    expect(ws.activeTabId).toBe(DB_QUERY_TAB_ID)
  })

  it('opens a table tab and focuses it', () => {
    const ws = openTableTab(defaultWorkspaceTabs(), 't1', 'public', 'users')
    expect(ws.tabs).toHaveLength(2)
    expect(ws.tabs[1]).toEqual({ tabId: 't1', kind: 'table-data', schema: 'public', table: 'users' })
    expect(ws.activeTabId).toBe('t1')
  })

  it('re-opening an open table just re-focuses (no duplicate)', () => {
    let ws = openTableTab(defaultWorkspaceTabs(), 't1', 'public', 'users')
    ws = setActiveTab(ws, DB_QUERY_TAB_ID)
    ws = openTableTab(ws, 't1', 'public', 'users')
    expect(ws.tabs).toHaveLength(2)
    expect(ws.activeTabId).toBe('t1')
  })

  it('closing the active tab focuses the left neighbor', () => {
    let ws = openTableTab(defaultWorkspaceTabs(), 't1', 's', 'a')
    ws = openTableTab(ws, 't2', 's', 'b')
    ws = closeTab(ws, 't2')
    expect(ws.tabs.map((t) => t.tabId)).toEqual([DB_QUERY_TAB_ID, 't1'])
    expect(ws.activeTabId).toBe('t1')
  })

  it('closing an inactive tab keeps the active one', () => {
    let ws = openTableTab(defaultWorkspaceTabs(), 't1', 's', 'a')
    ws = openTableTab(ws, 't2', 's', 'b')
    ws = setActiveTab(ws, 't2')
    ws = closeTab(ws, 't1')
    expect(ws.tabs.map((t) => t.tabId)).toEqual([DB_QUERY_TAB_ID, 't2'])
    expect(ws.activeTabId).toBe('t2')
  })

  it('never closes the permanent Query tab', () => {
    const ws = closeTab(defaultWorkspaceTabs(), DB_QUERY_TAB_ID)
    expect(ws.tabs).toHaveLength(1)
  })

  it('ignores activating a tab that does not exist', () => {
    const ws = setActiveTab(defaultWorkspaceTabs(), 'nope')
    expect(ws.activeTabId).toBe(DB_QUERY_TAB_ID)
  })
})
