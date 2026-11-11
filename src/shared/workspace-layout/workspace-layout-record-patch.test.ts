import { describe, expect, it } from 'vitest'
import { collectLayoutLeafIdsInOrder } from './terminal-pane-tree'
import { applyLayoutCommand } from './workspace-layout-commands'
import type { LayoutCommand } from './workspace-layout-command-types'
import { LEGACY_WORKSPACE_LAYOUT_PROFILES } from './workspace-layout-legacy-profile.test-fixture'
import { loadWorkspaceLayout } from './workspace-layout-load'
import { diffStoredSession } from './workspace-layout-load-report'
import { nameBasedLoadContext } from './workspace-layout-minted-ids'

import { WORKSPACE_LAYOUT_PROFILES } from './workspace-layout-profile.test-fixture'
import { patchStoredSession } from './workspace-layout-record-patch'
import { saveWorkspaceLayout } from './workspace-layout-save'
import type { WorkspaceSessionState } from '../workspace-session/workspace-session-state-types'

const CONTEXT = {
  mintId: () => 'minted-id',
  mintLeafId: () => '99999999-9999-4999-8999-999999999999',
  now: () => 1
}

const changedFields = (changes: ReturnType<typeof diffStoredSession>) =>
  changes.map(({ table, record, field }) => `${table}/${record}/${field}`).sort()

describe('patchStoredSession', () => {
  describe('a legacy row the load folds into a tab-bar tab', () => {
    const patchedBy = (
      name: string,
      command: (workspace: string) => LayoutCommand,
      edit: (stored: WorkspaceSessionState) => void = () => {}
    ) => {
      const profile = LEGACY_WORKSPACE_LAYOUT_PROFILES.find((candidate) => candidate.name === name)!
      const stored = profile.build()
      edit(stored)
      const loaded = loadWorkspaceLayout(profile.hostId, stored, nameBasedLoadContext())
      const workspace = Object.keys(stored.tabsByWorktree)[0]!
      const result = applyLayoutCommand(loaded.layout, command(workspace), CONTEXT)
      if (!result.ok) {
        throw new Error(result.code)
      }
      const after = saveWorkspaceLayout({ ...loaded, layout: result.model })
      return { stored, patched: patchStoredSession(stored, saveWorkspaceLayout(loaded), after) }
    }

    it('goes with the tab it repeats, and a selection naming it follows the load', () => {
      const { patched } = patchedBy(
        'legacy row repeating a tab-bar tab’s terminal, selected',
        (workspace) => ({ type: 'closeTabs', workspace, tabIds: ['tab-a'], force: true })
      )

      expect(Object.values(patched.tabsByWorktree)[0]!.map((row) => row.id)).toEqual(['tab-b'])
      expect(patched.terminalLayoutsByTabId['tab-legacy']).toBeUndefined()
      expect(patched.activeTabId).not.toBe('tab-legacy')
    })

    it('goes with the tab it repeats when they share only a remote session', () => {
      const { patched } = patchedBy(
        'legacy row repeating a tab-bar tab’s terminal',
        (workspace) => ({ type: 'closeTabs', workspace, tabIds: ['tab-a'], force: true }),
        (stored) => {
          for (const row of Object.values(stored.tabsByWorktree).flat()) {
            if (row.id !== 'tab-b') {
              row.ptyId = null
              stored.terminalLayoutsByTabId[row.id]!.ptyIdsByLeafId = {}
            }
          }
          stored.remoteSessionIdsByTabId = { 'tab-a': 'remote-1', 'tab-legacy': 'remote-1' }
        }
      )

      expect(Object.values(patched.tabsByWorktree)[0]!.map((row) => row.id)).toEqual(['tab-b'])
      expect(patched.terminalLayoutsByTabId['tab-legacy']).toBeUndefined()
    })

    it('keeps its loaded terminals when it gains a tab-bar entry, so the shared one stays put', () => {
      const { patched } = patchedBy(
        'legacy split row sharing one pane’s terminal with a tab-bar tab',
        (workspace) => ({
          type: 'moveTab',
          workspace,
          tabId: 'tab-legacy',
          toGroupId: 'g1',
          index: 0
        })
      )

      const rows = Object.values(patched.tabsByWorktree)[0]!
      expect(rows.find((row) => row.id === 'tab-legacy')?.ptyId).toBe('pty-c')
      expect(rows.find((row) => row.id === 'tab-a')?.ptyId).toBe('pty-a')
      expect(Object.values(patched.terminalLayoutsByTabId['tab-legacy']!.ptyIdsByLeafId!)).toEqual([
        'pty-c'
      ])
    })

    it('stays as stored when the tab it repeats is only renamed', () => {
      const { stored, patched } = patchedBy(
        'legacy row repeating a tab-bar tab’s terminal',
        (workspace) => ({
          type: 'renameTab',
          workspace,
          tabId: 'tab-a',
          kind: 'custom',
          title: 'Renamed'
        })
      )

      expect(patched.tabsByWorktree).not.toBe(stored.tabsByWorktree)
      expect(Object.values(patched.tabsByWorktree)[0]!.map((row) => row.id)).toContain('tab-legacy')
      expect(patched.terminalLayoutsByTabId['tab-legacy']).toEqual(
        stored.terminalLayoutsByTabId['tab-legacy']
      )
    })
  })

  it('does not write a sibling the load supplied when a close only renumbers it', () => {
    const profile = LEGACY_WORKSPACE_LAYOUT_PROFILES.find(
      (candidate) => candidate.name === 'row without a tab-bar entry, still bound to a terminal'
    )!
    const stored = profile.build()
    const loaded = loadWorkspaceLayout(profile.hostId, stored, nameBasedLoadContext())
    const [workspace] = Object.keys(stored.tabsByWorktree)
    const result = applyLayoutCommand(
      loaded.layout,
      { type: 'closeTabs', workspace: workspace!, tabIds: ['tab-a'], force: true },
      CONTEXT
    )
    if (!result.ok) {
      throw new Error(result.code)
    }

    const after = saveWorkspaceLayout({ ...loaded, layout: result.model })
    const patched = patchStoredSession(stored, saveWorkspaceLayout(loaded), after)

    expect(after.unifiedTabs?.[workspace!]?.map((entry) => entry.entityId)).toEqual(['tab-b'])
    expect(patched.unifiedTabs?.[workspace!] ?? []).toEqual([])
  })

  it('keeps a legacy partition’s unrelated records as stored when a pane splits', () => {
    const profile = LEGACY_WORKSPACE_LAYOUT_PROFILES.find(
      (candidate) => candidate.name === 'session from before the tab bar, with an open file'
    )!
    const stored = profile.build()
    const loaded = loadWorkspaceLayout(profile.hostId, stored, nameBasedLoadContext())
    const [workspace, tabs] = Object.entries(stored.tabsByWorktree)[0]!
    const tabId = tabs[0]!.id
    const leafId = collectLayoutLeafIdsInOrder(stored.terminalLayoutsByTabId[tabId]?.root)[0]!
    const result = applyLayoutCommand(
      loaded.layout,
      { type: 'splitPane', workspace, tabId, leafId, direction: 'vertical' },
      CONTEXT
    )
    if (!result.ok) {
      throw new Error(result.code)
    }

    const full = saveWorkspaceLayout({ ...loaded, layout: result.model })
    const patched = patchStoredSession(stored, saveWorkspaceLayout(loaded), full)

    expect(changedFields(diffStoredSession(stored, full)).length).toBeGreaterThan(2)
    expect(changedFields(diffStoredSession(stored, patched))).toEqual([
      `layout/${tabId}/root`,
      'session/session/terminalTopologyRevisionByRepoId'
    ])
    expect(Object.keys(patched).slice(0, Object.keys(stored).length)).toEqual(Object.keys(stored))
  })

  it('writes a layout the load supplied whole, so the split keeps the tab’s terminal', () => {
    const profile = WORKSPACE_LAYOUT_PROFILES[0]!
    const stored = profile.build()
    const [workspace, rows] = Object.entries(stored.tabsByWorktree).find(([, tabs]) =>
      tabs.some((tab) => tab.ptyId)
    )!
    const row = rows.find((tab) => tab.ptyId)!
    const { [row.id]: _dropped, ...layouts } = stored.terminalLayoutsByTabId
    stored.terminalLayoutsByTabId = layouts
    const loaded = loadWorkspaceLayout(profile.hostId, stored, nameBasedLoadContext())
    const tab = loaded.layout.workspaces[workspace]!.tabs.find((entry) => entry.id === row.id)
    const leafId = tab?.kind === 'terminal' ? collectLayoutLeafIdsInOrder(tab.panes.root)[0] : null
    const result = applyLayoutCommand(
      loaded.layout,
      { type: 'splitPane', workspace, tabId: row.id, leafId: leafId!, direction: 'vertical' },
      CONTEXT
    )
    if (!result.ok) {
      throw new Error(result.code)
    }
    const after = saveWorkspaceLayout({ ...loaded, layout: result.model })

    const patched = patchStoredSession(stored, saveWorkspaceLayout(loaded), after)

    expect(patched.terminalLayoutsByTabId[row.id]).toEqual(after.terminalLayoutsByTabId[row.id])
    expect(patched.terminalLayoutsByTabId[row.id]?.ptyIdsByLeafId?.[leafId!]).toBe(row.ptyId)
  })
})
