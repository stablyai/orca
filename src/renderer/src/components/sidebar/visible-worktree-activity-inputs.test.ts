import { describe, expect, it } from 'vitest'
import type { BrowserWorkspace, TerminalTab } from '../../../../shared/types'
import {
  getVisibleWorktreeBrowserActivityTabs,
  getVisibleWorktreeTerminalActivityTabs,
  getWorktreeSectionTerminalActivityTabs
} from './visible-worktree-activity-inputs'

function terminalTab(id: string, title: string): TerminalTab {
  return {
    id,
    ptyId: id,
    worktreeId: 'wt-1',
    title,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function browserTab(id: string, title: string): BrowserWorkspace {
  return {
    id,
    worktreeId: 'wt-1',
    activePageId: `${id}-page`,
    pageIds: [`${id}-page`],
    url: 'https://example.com',
    title,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0
  }
}

describe('visible worktree activity inputs', () => {
  it('preserves terminal activity projection when only tab metadata changes', () => {
    const first = getVisibleWorktreeTerminalActivityTabs({
      'wt-1': [terminalTab('tab-1', 'First')]
    })

    const second = getVisibleWorktreeTerminalActivityTabs({
      'wt-1': [terminalTab('tab-1', 'Renamed')]
    })

    expect(second).toBe(first)
    expect(second['wt-1']).toBe(first['wt-1'])
  })

  it('updates terminal activity projection when tab ids change', () => {
    const first = getVisibleWorktreeTerminalActivityTabs({
      'wt-1': [terminalTab('tab-1', 'First')]
    })

    const second = getVisibleWorktreeTerminalActivityTabs({
      'wt-1': [terminalTab('tab-1', 'First'), terminalTab('tab-2', 'Second')]
    })

    expect(second).not.toBe(first)
    expect(second['wt-1']?.map((tab) => tab.id)).toEqual(['tab-1', 'tab-2'])
  })

  it('reuses unchanged terminal worktree arrays when a sibling worktree changes', () => {
    const first = getVisibleWorktreeTerminalActivityTabs({
      'wt-1': [terminalTab('tab-1', 'First')],
      'wt-2': [terminalTab('tab-2', 'Second')]
    })

    const second = getVisibleWorktreeTerminalActivityTabs({
      'wt-1': [terminalTab('tab-1', 'Renamed')],
      'wt-2': [terminalTab('tab-3', 'Third')]
    })

    expect(second).not.toBe(first)
    expect(second['wt-1']).toBe(first['wt-1'])
    expect(second['wt-2']).not.toBe(first['wt-2'])
    expect(second['wt-2']?.map((tab) => tab.id)).toEqual(['tab-3'])
  })

  it('drops terminal projections for removed worktrees', () => {
    const first = getVisibleWorktreeTerminalActivityTabs({
      'wt-1': [terminalTab('tab-1', 'First')],
      'wt-2': [terminalTab('tab-2', 'Second')]
    })

    const second = getVisibleWorktreeTerminalActivityTabs({
      'wt-1': [terminalTab('tab-1', 'Renamed')]
    })

    expect(second).not.toBe(first)
    expect(Object.keys(second)).toEqual(['wt-1'])
    expect(second['wt-1']).toBe(first['wt-1'])
  })

  it('preserves section terminal projection when only wake bookkeeping changes', () => {
    const first = getWorktreeSectionTerminalActivityTabs({
      'wt-1': [terminalTab('tab-1', 'Codex working')]
    })

    const second = getWorktreeSectionTerminalActivityTabs({
      'wt-1': [
        {
          ...terminalTab('tab-1', 'Codex working'),
          generation: 2,
          pendingActivationSpawn: true
        }
      ]
    })

    // Why: slept-workspace wake updates generation/pendingActivationSpawn to
    // remount terminal panes; collapsed section dots only need id + title.
    expect(second).toBe(first)
    expect(second['wt-1']).toBe(first['wt-1'])
  })

  it('updates section terminal projection when terminal title changes', () => {
    const first = getWorktreeSectionTerminalActivityTabs({
      'wt-1': [terminalTab('tab-1', 'zsh')]
    })

    const second = getWorktreeSectionTerminalActivityTabs({
      'wt-1': [terminalTab('tab-1', 'Codex working')]
    })

    expect(second).not.toBe(first)
    expect(second['wt-1']).toEqual([{ id: 'tab-1', title: 'Codex working' }])
  })

  it('preserves browser activity projection when only browser metadata changes', () => {
    const first = getVisibleWorktreeBrowserActivityTabs({
      'wt-1': [browserTab('browser-1', 'First')]
    })

    const second = getVisibleWorktreeBrowserActivityTabs({
      'wt-1': [browserTab('browser-1', 'Renamed')]
    })

    expect(second).toBe(first)
    expect(second['wt-1']).toBe(first['wt-1'])
  })

  it('updates browser activity projection when browser ids change', () => {
    const first = getVisibleWorktreeBrowserActivityTabs({
      'wt-1': [browserTab('browser-1', 'First')]
    })

    const second = getVisibleWorktreeBrowserActivityTabs({
      'wt-1': [browserTab('browser-2', 'Second')]
    })

    expect(second).not.toBe(first)
    expect(second['wt-1']?.map((tab) => tab.id)).toEqual(['browser-2'])
  })

  it('drops browser projections for removed worktrees', () => {
    const first = getVisibleWorktreeBrowserActivityTabs({
      'wt-1': [browserTab('browser-1', 'First')],
      'wt-2': [browserTab('browser-2', 'Second')]
    })

    const second = getVisibleWorktreeBrowserActivityTabs({
      'wt-1': [browserTab('browser-1', 'Renamed')]
    })

    expect(second).not.toBe(first)
    expect(Object.keys(second)).toEqual(['wt-1'])
    expect(second['wt-1']).toBe(first['wt-1'])
  })
})
