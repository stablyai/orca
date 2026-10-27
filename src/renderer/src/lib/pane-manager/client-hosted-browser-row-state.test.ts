import { beforeEach, describe, expect, it } from 'vitest'
import type { ClientHostedBrowserRow } from '../../../../shared/client-hosted-browser-rows'
import {
  applyClientHostedBrowserRows,
  clearClientHostedBrowserRowSelection,
  getClientHostedBrowserRowSelection,
  getClientHostedBrowserRows,
  hydrateClientHostedBrowserRows,
  isClientHostedBrowserRowSelectionLive,
  resolveActiveClientHostedBrowserRowId,
  selectClientHostedBrowserRow
} from './client-hosted-browser-row-state'

function makeRow(overrides: Partial<ClientHostedBrowserRow> = {}): ClientHostedBrowserRow {
  return {
    browserPageId: 'page-1',
    worktreeId: 'wt-1',
    url: 'https://example.test/',
    title: 'Example',
    loading: false,
    browserHostClientId: 'host-a',
    hostDeviceName: 'Studio',
    hostAbsent: false,
    ...overrides
  }
}

beforeEach(() => {
  hydrateClientHostedBrowserRows([])
  clearClientHostedBrowserRowSelection()
})

describe('client-hosted browser row state', () => {
  it('replaces every worktree on hydration', () => {
    applyClientHostedBrowserRows({ worktreeId: 'wt-1', rows: [makeRow()] })

    hydrateClientHostedBrowserRows([
      { worktreeId: 'wt-2', rows: [makeRow({ worktreeId: 'wt-2', browserPageId: 'page-2' })] }
    ])

    expect(getClientHostedBrowserRows('wt-1')).toEqual([])
    expect(getClientHostedBrowserRows('wt-2')).toHaveLength(1)
  })
})

describe('client-hosted browser row selection', () => {
  const selection = {
    worktreeId: 'wt-1',
    browserPageId: 'page-1',
    groupId: 'group-1',
    groupActiveTabIdAtSelection: 'tab-1'
  }

  it('drops a selection whose row is retracted', () => {
    applyClientHostedBrowserRows({ worktreeId: 'wt-1', rows: [makeRow()] })
    selectClientHostedBrowserRow(selection)

    applyClientHostedBrowserRows({ worktreeId: 'wt-1', rows: [] })

    expect(getClientHostedBrowserRowSelection()).toBeNull()
  })

  it('drops a selection hydration no longer knows about', () => {
    applyClientHostedBrowserRows({ worktreeId: 'wt-1', rows: [makeRow()] })
    selectClientHostedBrowserRow(selection)

    hydrateClientHostedBrowserRows([])

    expect(getClientHostedBrowserRowSelection()).toBeNull()
  })

  it('dies when the group activates something else', () => {
    expect(
      isClientHostedBrowserRowSelectionLive(selection, [{ id: 'group-1', activeTabId: 'tab-2' }])
    ).toBe(false)
  })
})

/**
 * Both halves of a strip ask this one question, so its answers are what keep the strip from
 * underlining a real tab and a client-hosted row at the same time.
 */
describe('active client-hosted row for a strip', () => {
  const selection = {
    worktreeId: 'wt-1',
    browserPageId: 'page-1',
    groupId: 'group-1',
    groupActiveTabIdAtSelection: 'tab-1'
  }
  const scope = { worktreeId: 'wt-1', groupId: 'group-1', groupActiveTabId: 'tab-1' }

  it('leaves other strips alone', () => {
    expect(
      resolveActiveClientHostedBrowserRowId(selection, { ...scope, groupId: 'group-2' })
    ).toBeNull()
    expect(
      resolveActiveClientHostedBrowserRowId(selection, { ...scope, worktreeId: 'wt-2' })
    ).toBeNull()
  })
})
