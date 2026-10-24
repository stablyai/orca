import { describe, expect, it } from 'vitest'
import { collectLayoutLeafIdsInOrder } from './terminal-pane-tree'
import { applyLayoutCommand } from './workspace-layout-commands'
import type { LayoutCommand } from './workspace-layout-command-types'
import { LEGACY_WORKSPACE_LAYOUT_PROFILES } from './workspace-layout-legacy-profile.test-fixture'
import { loadWorkspaceLayout } from './workspace-layout-load'
import { diffStoredSession, stableJson } from './workspace-layout-load-report'
import { nameBasedLoadContext } from './workspace-layout-minted-ids'
import type { WorkspaceLayoutModel } from './workspace-layout-model'
import { WORKSPACE_LAYOUT_PROFILES } from './workspace-layout-profile.test-fixture'
import { patchStoredSession } from './workspace-layout-record-patch'
import { saveWorkspaceLayout } from './workspace-layout-save'
import type { WorkspaceSessionState } from '../workspace-session-state-types'

const CONTEXT = {
  mintId: () => 'minted-id',
  mintLeafId: () => '99999999-9999-4999-8999-999999999999',
  now: () => 1
}

/** Commands over every workspace and tab a profile holds, covering adds, drops, edits and moves. */
function commandsFor(model: WorkspaceLayoutModel): LayoutCommand[] {
  const commands: LayoutCommand[] = []
  for (const [workspace, layout] of Object.entries(model.workspaces)) {
    commands.push({ type: 'createTerminalTab', workspace })
    commands.push({ type: 'openEditorTab', workspace, fileId: '/new.md', contentType: 'editor' })
    commands.push({
      type: 'closeTabs',
      workspace,
      tabIds: ['tab-not-listed'],
      force: true,
      recordClose: 'cleanup'
    })
    const lastGroup = layout.groups.at(-1)
    if (layout.groupLayout?.type === 'split') {
      commands.push({
        type: 'setGroupRatios',
        workspace,
        groupLayout: { ...layout.groupLayout, ratio: 0.3 }
      })
    }
    for (const tab of layout.tabs) {
      commands.push({ type: 'closeTabs', workspace, tabIds: [tab.id], force: true })
      commands.push({
        type: 'closeTabs',
        workspace,
        tabIds: [tab.id],
        force: true,
        recordClose: 'user'
      })
      commands.push({
        type: 'renameTab',
        workspace,
        tabId: tab.id,
        kind: 'custom',
        title: 'Renamed'
      })
      if (lastGroup) {
        commands.push({
          type: 'moveTab',
          workspace,
          tabId: tab.id,
          toGroupId: lastGroup.id,
          index: 0
        })
        commands.push({
          type: 'splitGroup',
          workspace,
          tabId: tab.id,
          besideGroupId: lastGroup.id,
          direction: 'right'
        })
      }
      if (tab.kind !== 'terminal') {
        continue
      }
      const [first, second] = collectLayoutLeafIdsInOrder(tab.panes.root)
      if (first) {
        commands.push({
          type: 'splitPane',
          workspace,
          tabId: tab.id,
          leafId: first,
          direction: 'vertical'
        })
      }
      if (first) {
        commands.push({
          type: 'renamePane',
          workspace,
          tabId: tab.id,
          leafId: first,
          title: 'Pane'
        })
      }
      if (first) {
        commands.push({
          type: 'movePaneToNewTab',
          workspace,
          tabId: tab.id,
          leafId: first,
          windowDetach: { ptyId: 'pty-detached', tabId: 'tab-detached' }
        })
      }
      if (second) {
        commands.push({ type: 'movePaneToNewTab', workspace, tabId: tab.id, leafId: second })
        commands.push({ type: 'closePane', workspace, tabId: tab.id, leafId: second })
        commands.push({
          type: 'closePane',
          workspace,
          tabId: tab.id,
          leafId: second,
          userPaneClose: true
        })
        commands.push({ type: 'equalizePanes', workspace, tabId: tab.id })
        commands.push({
          type: 'movePane',
          workspace,
          tabId: tab.id,
          leafId: second,
          targetLeafId: first!,
          side: 'left'
        })
        if (tab.panes.root?.type === 'split') {
          commands.push({
            type: 'setPaneRatios',
            workspace,
            tabId: tab.id,
            root: { ...tab.panes.root, ratio: 0.7 }
          })
        }
      }
    }
  }
  return commands
}

const changedFields = (changes: ReturnType<typeof diffStoredSession>) =>
  changes.map(({ table, record, field }) => `${table}/${record}/${field}`).sort()
// Session fields are separate records here: one session field must not carry another along.
const changedRecords = (changes: ReturnType<typeof diffStoredSession>) => [
  ...new Set(
    changes.map(({ table, record, field }) =>
      table === 'session' ? `session/${field}` : `${table}/${record}`
    )
  )
]

const LIST_TABLES: Record<string, { order: string; field: string }> = {
  row: { order: 'row', field: 'tabsByWorktree' },
  terminalEntry: { order: 'entry', field: 'unifiedTabs' },
  entry: { order: 'entry', field: 'unifiedTabs' },
  group: { order: 'group', field: 'tabGroups' },
  file: { order: 'file', field: 'openFilesByWorktree' },
  browser: { order: 'browser', field: 'browserTabsByWorktree' }
}

/** A record written into a list the stored partition lacks also changes that list's order and keys. */
function withListConsequences(records: string[]): string[] {
  const allowed = new Set(records)
  for (const record of records) {
    const table = record.slice(0, record.indexOf('/'))
    const list = LIST_TABLES[table]
    if (list) {
      const key = record.slice(table.length + 1, record.lastIndexOf('|'))
      allowed.add(`${list.order}/${key}|$order`)
      allowed.add(`session/${list.field}`)
    }
  }
  return [...allowed]
}

describe('patchStoredSession', () => {
  const profiles = [...WORKSPACE_LAYOUT_PROFILES, ...LEGACY_WORKSPACE_LAYOUT_PROFILES]

  it.each(profiles.map((profile) => [profile.name, profile] as const))(
    '%s: writes only the records each command touched',
    (_name, profile) => {
      const stored = profile.build()
      const loaded = loadWorkspaceLayout(profile.hostId, stored, nameBasedLoadContext())
      const before = saveWorkspaceLayout(loaded)
      const normalizedAtLoad = diffStoredSession(stored, before).length > 0
      let applied = 0
      // Legacy rows the load folds into a tab-bar tab (dropped, or terminals taken off them).
      const entryIds = new Set(
        Object.values(stored.unifiedTabs ?? {})
          .flat()
          .map((entry) => entry.entityId)
      )
      const loadChanged = changedRecords(diffStoredSession(stored, before))
      const foldedIds = Object.values(stored.tabsByWorktree)
        .flat()
        .map((row) => row.id)
        .filter(
          (id) =>
            !entryIds.has(id) &&
            loadChanged.some((record) => record.endsWith(`|${id}`) || record === `layout/${id}`)
        )
      const isFolded = (record: string) =>
        foldedIds.some((id) => record.endsWith(`|${id}`) || record === `layout/${id}`)
      const selectionNamesFolded = foldedIds.some(
        (id) =>
          stored.activeTabId === id ||
          Object.values(stored.activeTabIdByWorktree ?? {}).includes(id)
      )
      for (const command of commandsFor(loaded.layout)) {
        const result = applyLayoutCommand(loaded.layout, command, CONTEXT)
        if (!result.ok) {
          continue
        }
        applied++
        const after = saveWorkspaceLayout({ ...loaded, layout: result.model })
        const patched = patchStoredSession(stored, before, after)
        const label = `${command.type} ${JSON.stringify(command)}`
        if (!normalizedAtLoad) {
          // A partition the load leaves alone: the patch is the full save, field for field.
          expect(stableJson(patched), label).toBe(stableJson(after))
        }
        // The written partition loads to what the command produced. The revision is exempt: the
        // load's tombstone retirement bumps it again on every load.
        const reloaded = (session: typeof stored) => ({
          ...saveWorkspaceLayout(
            loadWorkspaceLayout(profile.hostId, session, nameBasedLoadContext())
          ),
          terminalTopologyRevisionByRepoId: undefined
        })
        expect(stableJson(reloaded(patched)), label).toBe(stableJson(reloaded(after)))
        const written = changedRecords(diffStoredSession(stored, patched))
        // A folded row may be written only in its loaded form, and a selection naming it with it.
        const notLoadForm = new Set(changedRecords(diffStoredSession(before, patched)))
        const loadForms = written.filter(
          (record) =>
            !notLoadForm.has(record) &&
            (isFolded(record) ||
              (selectionNamesFolded &&
                ['session/activeTabId', 'session/activeTabIdByWorktree'].includes(record)))
        )
        const commanded = withListConsequences([
          ...changedRecords(diffStoredSession(before, after)),
          ...loadForms
        ])
        // A map the stored partition lacks is reported whole on one side, by record on the other.
        const wholeMaps = commanded.includes('session/closedTerminalTabTombstonesByTabId')
          ? ['closedTab/']
          : []
        expect(
          written.filter(
            (record) =>
              !commanded.includes(record) && !wholeMaps.some((table) => record.startsWith(table))
          ),
          `${label} commanded=${commanded.join(',')}`
        ).toEqual([])
      }
      expect(applied > 0 || Object.keys(loaded.layout.workspaces).length === 0).toBe(true)
    }
  )

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
    // Stored fields keep their order; the command's new field follows them.
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
