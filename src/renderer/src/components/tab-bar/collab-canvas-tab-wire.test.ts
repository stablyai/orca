/**
 * G1 final step: collab-canvas is a first-class workspace tab type.
 */
import { describe, expect, it } from 'vitest'
import { sessionCollabCanvasBinding } from '../../../../shared/collab-canvas-binding'
import { toVisibleTabTypeForTest } from '../tab-group/collab-canvas-tab-wire-helpers'
import {
  buildTabCreateMenuOptions,
  findMatchingTabCreateMenuOptions
} from './tab-create-menu-options'
import { getGroupVisibleTabOrder } from './group-tab-order'
import type { Tab, TabGroup } from '../../../../shared/types'
import { reconcileTabOrder } from './reconcile-order'

describe('toVisibleTabType (collab-canvas)', () => {
  it('maps collab-canvas to itself rather than editor', () => {
    expect(toVisibleTabTypeForTest('collab-canvas')).toBe('collab-canvas')
  })
  it('still maps editor-like types to editor', () => {
    expect(toVisibleTabTypeForTest('diff')).toBe('editor')
    expect(toVisibleTabTypeForTest('editor')).toBe('editor')
  })
})

describe('sessionCollabCanvasBinding', () => {
  it('builds a session binding from worktree + board id', () => {
    expect(sessionCollabCanvasBinding('wt-1', 'board-a')).toEqual({
      kind: 'session',
      worktreeId: 'wt-1',
      boardId: 'board-a'
    })
  })
})

describe('tab create menu includes collab board', () => {
  it('offers New Collab Board when enabled', () => {
    const options = buildTabCreateMenuOptions({
      terminalOnly: false,
      hasNewBrowser: true,
      hasNewCollabCanvas: true,
      hasNewMarkdown: false,
      hasOpenMarkdown: false,
      hasSimulator: false,
      simulatorIsGoTo: false
    })
    expect(options.some((o) => o.kind === 'new-collab-canvas')).toBe(true)
  })

  it('matches whiteboard search keywords', () => {
    const options = buildTabCreateMenuOptions({
      terminalOnly: false,
      hasNewBrowser: false,
      hasNewCollabCanvas: true,
      hasNewMarkdown: false,
      hasOpenMarkdown: false,
      hasSimulator: false,
      simulatorIsGoTo: false
    })
    const hits = findMatchingTabCreateMenuOptions('whiteboard', options)
    expect(hits.map((h) => h.kind)).toContain('new-collab-canvas')
  })
})

describe('group visible tab order includes collab-canvas', () => {
  it('lists a board tab in the strip order', () => {
    const group: TabGroup = {
      id: 'g1',
      worktreeId: 'wt-1',
      activeTabId: 'u-board',
      tabOrder: ['u-term', 'u-board'],
      recentTabIds: []
    }
    const tabs: Tab[] = [
      {
        id: 'u-term',
        entityId: 'term-1',
        groupId: 'g1',
        worktreeId: 'wt-1',
        contentType: 'terminal',
        label: 't',
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: 0
      },
      {
        id: 'u-board',
        entityId: 'board-1',
        groupId: 'g1',
        worktreeId: 'wt-1',
        contentType: 'collab-canvas',
        label: 'Collab Board',
        customLabel: null,
        color: null,
        sortOrder: 1,
        createdAt: 0
      }
    ]
    const order = getGroupVisibleTabOrder(
      group,
      tabs,
      new Set(['term-1']),
      new Set(),
      new Set(),
      new Set(),
      new Set(['u-board'])
    )
    expect(order.map((e) => e.type)).toEqual(['terminal', 'collab-canvas'])
  })
})

describe('reconcileTabOrder collab canvas ids', () => {
  it('keeps board ids in the reconciled strip', () => {
    const ids = reconcileTabOrder(['u-board', 'term-1'], ['term-1'], [], [], [], ['u-board'])
    expect(ids).toEqual(['u-board', 'term-1'])
  })
})
