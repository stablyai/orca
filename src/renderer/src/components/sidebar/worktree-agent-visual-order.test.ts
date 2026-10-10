import { describe, expect, it } from 'vitest'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import { orderAgentsByVisibleTabs } from './worktree-agent-visual-order'

function tab(
  id: string,
  groupId = 'g',
  entityId = id,
  contentType: Tab['contentType'] = 'terminal'
): Tab {
  return {
    id,
    entityId,
    groupId,
    contentType,
    worktreeId: 'w',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function group(id: string, tabOrder: string[]): TabGroup {
  return { id, worktreeId: 'w', activeTabId: null, tabOrder }
}

const rows = ['claude', 'codex'].map((id) => ({ tab: { id } }))

describe('sidebar visual agent order', () => {
  it('follows a dragged group order even when terminal rows keep their original order', () => {
    const result = orderAgentsByVisibleTabs(
      rows,
      [tab('claude'), tab('codex')],
      [group('g', ['codex', 'claude'])],
      undefined,
      ['claude', 'codex']
    )
    expect(result.map((row) => row.tab.id)).toEqual(['codex', 'claude'])
    expect(rows.map((row) => row.tab.id)).toEqual(['claude', 'codex'])
  })

  it('resolves unified terminal ids to their backing ids and keeps split panes together', () => {
    const splitRows = [rows[0], rows[1], { tab: { id: 'claude' }, pane: 'second' }]
    const result = orderAgentsByVisibleTabs(
      splitRows,
      [tab('u-claude', 'g', 'claude'), tab('u-codex', 'g', 'codex')],
      [group('g', ['u-codex', 'u-claude'])],
      undefined,
      []
    )
    expect(result).toEqual([splitRows[1], splitRows[0], splitRows[2]])
  })

  it('walks pane layout order rather than group creation order', () => {
    expect(
      orderAgentsByVisibleTabs(
        rows,
        [tab('claude', 'left'), tab('codex', 'right')],
        [group('right', ['codex']), group('left', ['claude'])],
        {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'left' },
          second: { type: 'leaf', groupId: 'right' }
        },
        []
      ).map((row) => row.tab.id)
    ).toEqual(['claude', 'codex'])
  })

  it('handles structured sessions among editor/browser tabs and newly hydrated tabs', () => {
    const tabs = [
      tab('file', 'g', 'file', 'editor'),
      tab('claude', 'g', 'session', 'agent-session'),
      tab('web', 'g', 'web', 'browser'),
      tab('codex')
    ]
    expect(
      orderAgentsByVisibleTabs(
        rows,
        tabs,
        [group('g', ['web', 'missing', 'codex', 'file'])],
        undefined,
        []
      ).map((row) => row.tab.id)
    ).toEqual(['codex', 'claude'])
  })

  it('ranks a declared structured session by unified tab id rather than its entity id', () => {
    expect(
      orderAgentsByVisibleTabs(
        rows,
        [tab('claude', 'g', 'session', 'agent-session'), tab('codex')],
        [group('g', ['claude', 'codex'])],
        undefined,
        []
      )
    ).toEqual(rows)
  })

  it('keeps retained/unplaced rows and uses legacy order before groups hydrate', () => {
    const all = [...rows, { tab: { id: 'retained' } }]
    expect(orderAgentsByVisibleTabs(all, [], [], undefined, ['codex', 'claude'])).toEqual([
      all[1],
      all[0],
      all[2]
    ])
    expect(orderAgentsByVisibleTabs(all, [], [], undefined, [])).toBe(all)
    expect(
      orderAgentsByVisibleTabs(
        rows,
        [tab('claude'), tab('codex')],
        [group('g', ['claude', 'codex'])],
        undefined,
        []
      )
    ).toBe(rows)
  })
})
