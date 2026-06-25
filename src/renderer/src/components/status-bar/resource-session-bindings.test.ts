import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import {
  buildResourceSessionBindingIndex,
  countUnboundDaemonSessions
} from './resource-session-bindings'

function makeTab(id: string, ptyId: string | null = null): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId: 'repo::/workspace',
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    type: 'terminal',
    paneCount: 1
  } as unknown as TerminalTab
}

function makeLayout(ptyIdsByLeafId: Record<string, string>): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: 'leaf-1' },
    activeLeafId: 'leaf-1',
    expandedLeafId: null,
    ptyIdsByLeafId
  }
}

describe('resource session bindings', () => {
  it('combines live PTYs with restored tab and split-pane wake hints', () => {
    const index = buildResourceSessionBindingIndex({
      ptyIdsByTabId: {
        'tab-active': ['pty-live', 'pty-live']
      },
      tabsByWorktree: {
        'repo::/workspace': [makeTab('tab-active'), makeTab('tab-restored', 'pty-restored')]
      },
      terminalLayoutsByTabId: {
        'tab-restored': makeLayout({
          'leaf-1': 'pty-leaf-a',
          'leaf-2': 'pty-leaf-b'
        })
      },
      workspaceSessionReady: true
    })

    expect(index.ptyIdToTabId).toEqual(
      new Map([
        ['pty-live', 'tab-active'],
        ['pty-restored', 'tab-restored'],
        ['pty-leaf-a', 'tab-restored'],
        ['pty-leaf-b', 'tab-restored']
      ])
    )
    expect([...index.boundPtyIds].sort()).toEqual([
      'pty-leaf-a',
      'pty-leaf-b',
      'pty-live',
      'pty-restored'
    ])
  })

  it('ignores stale layout-only PTYs after their tab is gone', () => {
    const index = buildResourceSessionBindingIndex({
      ptyIdsByTabId: {},
      tabsByWorktree: {
        'repo::/workspace': [makeTab('tab-live', null)]
      },
      terminalLayoutsByTabId: {
        'tab-closed': makeLayout({ 'leaf-1': 'pty-closed' })
      },
      workspaceSessionReady: true
    })

    expect(index.ptyIdToTabId.has('pty-closed')).toBe(false)
    expect(index.boundPtyIds.has('pty-closed')).toBe(false)
  })

  it('counts only daemon sessions without live or restorable tab bindings', () => {
    const count = countUnboundDaemonSessions(
      [
        { id: 'pty-live', cwd: '/workspace', title: 'live' },
        { id: 'pty-restored', cwd: '/workspace', title: 'restored' },
        { id: 'pty-orphan', cwd: '/tmp', title: 'orphan' }
      ],
      {
        ptyIdsByTabId: { 'tab-live': ['pty-live'] },
        tabsByWorktree: {
          'repo::/workspace': [makeTab('tab-live'), makeTab('tab-restored', 'pty-restored')]
        },
        terminalLayoutsByTabId: {},
        workspaceSessionReady: true
      }
    )

    expect(count).toBe(1)
  })
})
