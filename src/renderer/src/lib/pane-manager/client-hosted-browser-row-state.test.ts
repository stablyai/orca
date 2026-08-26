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
  it('holds the rows a push delivers for a worktree', () => {
    applyClientHostedBrowserRows({ worktreeId: 'wt-1', rows: [makeRow()] })

    expect(getClientHostedBrowserRows('wt-1')).toEqual([makeRow()])
    expect(getClientHostedBrowserRows('wt-2')).toEqual([])
  })

  it('replaces a worktree wholesale on each push', () => {
    applyClientHostedBrowserRows({ worktreeId: 'wt-1', rows: [makeRow()] })
    applyClientHostedBrowserRows({
      worktreeId: 'wt-1',
      rows: [makeRow({ browserPageId: 'page-2' })]
    })

    expect(getClientHostedBrowserRows('wt-1').map((row) => row.browserPageId)).toEqual(['page-2'])
  })

  it('drops a worktree an empty push retracts', () => {
    applyClientHostedBrowserRows({ worktreeId: 'wt-1', rows: [makeRow()] })
    applyClientHostedBrowserRows({ worktreeId: 'wt-1', rows: [] })

    expect(getClientHostedBrowserRows('wt-1')).toEqual([])
  })

  it('live-updates a row title and its host-absent state', () => {
    applyClientHostedBrowserRows({ worktreeId: 'wt-1', rows: [makeRow()] })
    applyClientHostedBrowserRows({
      worktreeId: 'wt-1',
      rows: [makeRow({ title: 'Renamed', hostAbsent: true })]
    })

    expect(getClientHostedBrowserRows('wt-1')[0]).toMatchObject({
      title: 'Renamed',
      hostAbsent: true
    })
  })

  it('replaces every worktree on hydration', () => {
    applyClientHostedBrowserRows({ worktreeId: 'wt-1', rows: [makeRow()] })

    hydrateClientHostedBrowserRows([
      { worktreeId: 'wt-2', rows: [makeRow({ worktreeId: 'wt-2', browserPageId: 'page-2' })] }
    ])

    expect(getClientHostedBrowserRows('wt-1')).toEqual([])
    expect(getClientHostedBrowserRows('wt-2')).toHaveLength(1)
  })

  it('keeps a stable empty array so a snapshot read cannot loop a render', () => {
    expect(getClientHostedBrowserRows('wt-1')).toBe(getClientHostedBrowserRows('wt-2'))
  })
})

describe('client-hosted browser row selection', () => {
  const selection = {
    worktreeId: 'wt-1',
    browserPageId: 'page-1',
    groupId: 'group-1',
    groupActiveTabIdAtSelection: 'tab-1'
  }

  it('holds and clears a selection', () => {
    selectClientHostedBrowserRow(selection)
    expect(getClientHostedBrowserRowSelection()).toEqual(selection)

    clearClientHostedBrowserRowSelection()
    expect(getClientHostedBrowserRowSelection()).toBeNull()
  })

  it('drops a selection whose row is retracted', () => {
    applyClientHostedBrowserRows({ worktreeId: 'wt-1', rows: [makeRow()] })
    selectClientHostedBrowserRow(selection)

    applyClientHostedBrowserRows({ worktreeId: 'wt-1', rows: [] })

    expect(getClientHostedBrowserRowSelection()).toBeNull()
  })

  it('keeps a selection while its row survives a push', () => {
    applyClientHostedBrowserRows({ worktreeId: 'wt-1', rows: [makeRow()] })
    selectClientHostedBrowserRow(selection)

    applyClientHostedBrowserRows({
      worktreeId: 'wt-1',
      rows: [makeRow({ title: 'Renamed' }), makeRow({ browserPageId: 'page-2' })]
    })

    expect(getClientHostedBrowserRowSelection()).toEqual(selection)
  })

  it('drops a selection hydration no longer knows about', () => {
    applyClientHostedBrowserRows({ worktreeId: 'wt-1', rows: [makeRow()] })
    selectClientHostedBrowserRow(selection)

    hydrateClientHostedBrowserRows([])

    expect(getClientHostedBrowserRowSelection()).toBeNull()
  })

  it('stays live while its group still shows the tab it was picked over', () => {
    expect(
      isClientHostedBrowserRowSelectionLive(selection, [{ id: 'group-1', activeTabId: 'tab-1' }])
    ).toBe(true)
  })

  it('dies when the group activates something else', () => {
    expect(
      isClientHostedBrowserRowSelectionLive(selection, [{ id: 'group-1', activeTabId: 'tab-2' }])
    ).toBe(false)
  })

  it('dies when its group is gone', () => {
    expect(
      isClientHostedBrowserRowSelectionLive(selection, [{ id: 'group-2', activeTabId: 'tab-1' }])
    ).toBe(false)
  })

  it('treats a group with no active tab as the same empty selection context', () => {
    const overEmptyGroup = { ...selection, groupActiveTabIdAtSelection: null }

    expect(isClientHostedBrowserRowSelectionLive(overEmptyGroup, [{ id: 'group-1' }])).toBe(true)
    expect(
      isClientHostedBrowserRowSelectionLive(overEmptyGroup, [
        { id: 'group-1', activeTabId: 'tab-1' }
      ])
    ).toBe(false)
  })

  it('is never live with nothing selected', () => {
    expect(
      isClientHostedBrowserRowSelectionLive(null, [{ id: 'group-1', activeTabId: null }])
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

  it('names the picked row', () => {
    expect(resolveActiveClientHostedBrowserRowId(selection, scope)).toBe('page-1')
  })

  it('names nothing with no selection', () => {
    expect(resolveActiveClientHostedBrowserRowId(null, scope)).toBeNull()
  })

  it('names nothing once the group activates another tab', () => {
    expect(
      resolveActiveClientHostedBrowserRowId(selection, { ...scope, groupActiveTabId: 'tab-2' })
    ).toBeNull()
  })

  it('leaves other strips alone', () => {
    expect(
      resolveActiveClientHostedBrowserRowId(selection, { ...scope, groupId: 'group-2' })
    ).toBeNull()
    expect(
      resolveActiveClientHostedBrowserRowId(selection, { ...scope, worktreeId: 'wt-2' })
    ).toBeNull()
  })
})
