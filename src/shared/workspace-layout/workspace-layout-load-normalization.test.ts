// Stored data older builds can leave disagreeing with itself. Each case is one fixed Loader rule
// from the design (section 7); everything the rule does not name must survive unchanged.

import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../execution-host'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import { loadWorkspaceLayout } from './workspace-layout-load'
import { checkWorkspaceLayoutModelRules } from './workspace-layout-model-rules'
import { checkWorkspaceLayoutRules } from './workspace-layout-rules'
import { checkLayoutRoundTrip } from './workspace-layout-round-trip-check'
import { saveWorkspaceLayout } from './workspace-layout-save'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  leaf,
  SSH_KEY
} from './workspace-layout-session.test-fixture'
import { sleepingRecord } from './workspace-layout-profile.test-fixture'

const onDisk = (session: WorkspaceSessionState): WorkspaceSessionState =>
  JSON.parse(JSON.stringify(session))

function load(session: WorkspaceSessionState) {
  // Each rule's changes are kinds the shadow self-check knows, and its output is a fixed point.
  expect(checkLayoutRoundTrip(LOCAL_EXECUTION_HOST_ID, session).findings).toEqual([])
  let next = 0
  return loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, session, {
    mintId: () => `minted-${++next}`,
    mintLeafId: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`
  })
}

function twoTabs(): WorkspaceSessionState {
  return addWorkspace(emptySession(), GIT_KEY, [
    {
      id: 'g1',
      tabs: [
        { id: 'tab-a', leaves: [[leaf(1), 'pty-a']] },
        { id: 'tab-b', leaves: [[leaf(2), 'pty-b']] }
      ]
    }
  ])
}

/** Which on-disk fields the load's change report names, as `table.field`. */
const changed = (loaded: ReturnType<typeof load>): string[] =>
  [...new Set(loaded.changes.map((change) => `${change.table}.${change.field}`))].sort()

const rules = (session: WorkspaceSessionState) =>
  checkWorkspaceLayoutRules([{ hostId: LOCAL_EXECUTION_HOST_ID, session }]).map(
    (violation) => violation.rule
  )

describe('Loader precedence for stored data that disagrees with itself, and its change report', () => {
  it('gives terminal rows saved without a tab bar (headless runtime) an entry in a new first group', () => {
    const stored = twoTabs()
    stored.unifiedTabs = {}
    stored.tabGroups = {}
    stored.tabGroupLayouts = {}
    expect(rules(stored)).toEqual(['tab_bar_missing'])
    const loaded = load(stored)
    expect(changed(loaded)).toEqual([
      'entry.*',
      'group.*',
      'session.tabGroupLayouts',
      'session.tabGroups',
      'session.unifiedTabs',
      'terminalEntry.*'
    ])
    const saved = saveWorkspaceLayout(loaded)
    expect(saved.tabGroups?.[GIT_KEY]).toEqual([
      { id: 'minted-1', worktreeId: GIT_KEY, activeTabId: null, tabOrder: ['tab-a', 'tab-b'] }
    ])
    expect(saved.unifiedTabs?.[GIT_KEY]?.map((tab) => [tab.id, tab.label, tab.sortOrder])).toEqual([
      ['tab-a', 'Terminal 1', 0],
      ['tab-b', 'Terminal 2', 1]
    ])
    expect(saved.tabGroupLayouts?.[GIT_KEY]).toEqual({ type: 'leaf', groupId: 'minted-1' })
    expect(onDisk(saved).tabsByWorktree).toEqual(onDisk(stored).tabsByWorktree)
    expect(rules(saved)).toEqual([])
  })

  it('takes the group tab order over both sortOrders and rewrites rows and sortOrders from it', () => {
    const stored = twoTabs()
    stored.tabGroups![GIT_KEY]![0]!.tabOrder = ['tab-b', 'tab-a']
    stored.tabsByWorktree[GIT_KEY]![1]!.sortOrder = 9
    expect(rules(stored)).toEqual(['tab_order_disagrees'])
    const loaded = load(stored)
    expect(changed(loaded)).toEqual([
      'entry.$order',
      'row.$order',
      'row.sortOrder',
      'terminalEntry.sortOrder'
    ])
    const saved = saveWorkspaceLayout(loaded)
    expect(saved.tabsByWorktree[GIT_KEY]!.map((row) => [row.id, row.sortOrder])).toEqual([
      ['tab-b', 0],
      ['tab-a', 1]
    ])
    expect(rules(saved)).toEqual([])
    // Tab-bar entries are written in the one tab order too.
    expect(saved.unifiedTabs![GIT_KEY]!.map((tab) => [tab.id, tab.sortOrder])).toEqual([
      ['tab-b', 0],
      ['tab-a', 1]
    ])
  })

  it('orders a tab no group lists by tab-bar sortOrder, then row sortOrder, then creation time', () => {
    const stored = twoTabs()
    stored.tabGroups![GIT_KEY]![0]!.tabOrder = []
    stored.unifiedTabs![GIT_KEY]![0]!.sortOrder = 5
    const loaded = load(stored)
    expect(loaded.layout.workspaces[GIT_KEY]!.groups[0]!.tabOrder).toEqual(['tab-b', 'tab-a'])
  })

  it('unbinds the later of two panes bound to one terminal, in tab order', () => {
    const stored = twoTabs()
    stored.terminalLayoutsByTabId['tab-b']!.ptyIdsByLeafId = { [leaf(2)]: 'pty-a' }
    stored.tabsByWorktree[GIT_KEY]![1]!.ptyId = 'pty-a'
    expect(rules(stored)).toEqual(['terminal_in_two_panes'])
    const loaded = load(stored)
    expect(changed(loaded)).toEqual(['layout.ptyIdsByLeafId', 'row.ptyId'])
    const saved = saveWorkspaceLayout(loaded)
    expect(saved.terminalLayoutsByTabId['tab-a']!.ptyIdsByLeafId).toEqual({ [leaf(1)]: 'pty-a' })
    expect(saved.terminalLayoutsByTabId['tab-b']!.ptyIdsByLeafId).toEqual({})
    expect(rules(saved)).toEqual([])
  })

  it('drops a tab-bar terminal entry whose row is gone and a row a second workspace repeats', () => {
    const stored = addWorkspace(twoTabs(), SSH_KEY, [
      { id: 'g2', tabs: [{ id: 'tab-a', leaves: [[leaf(3)]] }] }
    ])
    stored.tabsByWorktree[GIT_KEY] = stored.tabsByWorktree[GIT_KEY]!.filter(
      (row) => row.id !== 'tab-b'
    )
    const loaded = load(stored)
    expect(changed(loaded)).toEqual(
      expect.arrayContaining(['row.*', 'terminalEntry.*', 'group.*', 'group.tabOrder', 'row.ptyId'])
    )
    // tab-b's pane layout outlived its row: carried as stored, outside the model, so the disk
    // rules still report it.
    expect(checkWorkspaceLayoutModelRules([loaded.layout])).toEqual([])
    expect(rules(saveWorkspaceLayout(loaded))).toEqual(['pane_without_tab'])
  })

  it('keeps a row stored in two workspaces where the tab bar names it, not by key order', () => {
    const stored = addWorkspace(twoTabs(), SSH_KEY, [
      { id: 'g2', tabs: [{ id: 'tab-c', leaves: [[leaf(3)]] }] }
    ])
    stored.tabsByWorktree[SSH_KEY]!.unshift({
      ...stored.tabsByWorktree[GIT_KEY]![0]!,
      worktreeId: SSH_KEY
    })
    stored.unifiedTabs![GIT_KEY] = stored.unifiedTabs![GIT_KEY]!.filter((tab) => tab.id !== 'tab-a')
    stored.tabGroups![GIT_KEY]![0]!.tabOrder = ['tab-b']
    stored.unifiedTabs![SSH_KEY]!.push({
      ...stored.unifiedTabs![SSH_KEY]![0]!,
      id: 'tab-a',
      entityId: 'tab-a'
    })
    stored.tabGroups![SSH_KEY]![0]!.tabOrder.push('tab-a')
    const loaded = load(stored)
    expect(loaded.changes).toContainEqual(
      expect.objectContaining({ table: 'row', record: `${GIT_KEY}|tab-a`, field: '*' })
    )
    expect(loaded.layout.workspaces[SSH_KEY]!.tabs.map((tab) => tab.id)).toContain('tab-a')
    expect(loaded.layout.workspaces[GIT_KEY]!.tabs.map((tab) => tab.id)).toEqual(['tab-b'])
  })

  it('gives the later of two tabs sharing a pane id a new unbound pane', () => {
    const stored = twoTabs()
    stored.terminalLayoutsByTabId['tab-b'] = {
      ...stored.terminalLayoutsByTabId['tab-b']!,
      root: { type: 'leaf', leafId: leaf(1) },
      activeLeafId: leaf(1),
      expandedLeafId: leaf(1),
      ptyIdsByLeafId: { [leaf(1)]: 'pty-b' },
      titlesByLeafId: { [leaf(1)]: 'logs' },
      buffersByLeafId: { [leaf(1)]: 'scrollback-b' }
    }
    stored.tabsByWorktree[GIT_KEY]![1]!.ptyId = 'pty-b'
    const sleeping = sleepingRecord(GIT_KEY, 'tab-b', leaf(1))
    stored.sleepingAgentSessionsByPaneKey = { [sleeping.paneKey]: sleeping }
    stored.terminalPtyIncarnationsByPaneKey = { [`tab-b:${leaf(1)}`]: 'inc-b' }
    expect(rules(stored)).toEqual(['pane_in_two_tabs'])
    const loaded = load(stored)
    expect(changed(loaded)).toEqual(
      expect.arrayContaining(['layout.root', 'layout.ptyIdsByLeafId', 'sleeping.*'])
    )
    const saved = saveWorkspaceLayout(loaded)
    const moved = saved.terminalLayoutsByTabId['tab-b']!
    const fresh = moved.activeLeafId!
    expect(fresh).not.toBe(leaf(1))
    expect(moved.root).toEqual({ type: 'leaf', leafId: fresh })
    expect(moved.ptyIdsByLeafId).toEqual({})
    expect(moved.titlesByLeafId).toEqual({ [fresh]: 'logs' })
    // Everything keyed by the old pane follows it, so no record or view entry is orphaned.
    expect(moved).toMatchObject({
      activeLeafId: fresh,
      expandedLeafId: fresh,
      buffersByLeafId: { [fresh]: 'scrollback-b' }
    })
    expect(Object.keys(saved.sleepingAgentSessionsByPaneKey!)).toEqual([`tab-b:${fresh}`])
    expect(saved.sleepingAgentSessionsByPaneKey![`tab-b:${fresh}`]!.paneKey).toBe(`tab-b:${fresh}`)
    expect(saved.terminalPtyIncarnationsByPaneKey).toEqual({ [`tab-b:${fresh}`]: 'inc-b' })
    expect(saved.terminalLayoutsByTabId['tab-a']!.ptyIdsByLeafId).toEqual({ [leaf(1)]: 'pty-a' })
    expect(rules(saved)).toEqual([])
  })

  it('gives the second of one leaf id twice in a tab a new id; the pane key names the first', () => {
    const stored = twoTabs()
    stored.terminalLayoutsByTabId['tab-b']!.root = {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: leaf(2) },
      second: { type: 'leaf', leafId: leaf(2) }
    }
    stored.terminalPtyIncarnationsByPaneKey = { [`tab-b:${leaf(2)}`]: 'inc-b' }
    expect(rules(stored)).toEqual(['pane_twice_in_one_tab'])
    const loaded = load(stored)
    expect(changed(loaded)).toEqual(['layout.root'])
    const saved = saveWorkspaceLayout(loaded)
    expect(saved.terminalLayoutsByTabId['tab-b']!.ptyIdsByLeafId).toEqual({ [leaf(2)]: 'pty-b' })
    expect(saved.terminalPtyIncarnationsByPaneKey).toEqual({ [`tab-b:${leaf(2)}`]: 'inc-b' })
    expect(rules(saved)).toEqual([])
  })

  it('reports each fact the two records or the workspace records name differently, keeping one', () => {
    const stored = twoTabs()
    stored.unifiedTabs![GIT_KEY]![0]!.color = '#ff0000'
    stored.tabGroups![GIT_KEY]![0]!.worktreeId = 'repo-1::/elsewhere'
    stored.unifiedTabs![GIT_KEY]![1]!.executionHostId = 'ssh:other'
    const loaded = load(stored)
    expect(loaded.changes).toEqual([
      expect.objectContaining({ table: 'terminalEntry', field: 'color', before: '#ff0000' }),
      expect.objectContaining({
        table: 'terminalEntry',
        field: 'executionHostId',
        before: 'ssh:other'
      }),
      expect.objectContaining({ table: 'group', field: 'worktreeId', after: GIT_KEY })
    ])
    const saved = saveWorkspaceLayout(loaded)
    expect(saved.unifiedTabs![GIT_KEY]![0]!.color).toBeNull()
    expect(saved.tabGroups![GIT_KEY]![0]!.worktreeId).toBe(GIT_KEY)
    expect(saved.unifiedTabs![GIT_KEY]![1]!.executionHostId).toBe(LOCAL_EXECUTION_HOST_ID)
  })

  function withEditorTabs(
    file: { isPreview?: boolean; externalSshTargetId?: string },
    tabs: { id: string; isPreview?: boolean; executionHostId?: ExecutionHostId }[]
  ): WorkspaceSessionState {
    const stored = twoTabs()
    const fileRecord = {
      filePath: '/w/a.ts',
      relativePath: 'a.ts',
      worktreeId: GIT_KEY,
      language: 'ts'
    }
    stored.openFilesByWorktree = { [GIT_KEY]: [{ ...fileRecord, ...file }] }
    for (const tab of tabs) {
      stored.unifiedTabs![GIT_KEY]!.push({
        ...stored.unifiedTabs![GIT_KEY]![0]!,
        ...tab,
        entityId: '/w/a.ts',
        contentType: 'editor',
        sortOrder: stored.tabGroups![GIT_KEY]![0]!.tabOrder.push(tab.id) - 1
      })
    }
    return stored
  }

  const previewReports = (loaded: ReturnType<typeof load>) =>
    loaded.changes.filter((change) => change.field === 'isPreview')

  it('makes an editor tab permanent where its two stored preview flags disagree, and reports it', () => {
    for (const [file, tab, demoted] of [
      [true, false, 'file'],
      [false, true, 'entry']
    ] as const) {
      const loaded = load(withEditorTabs({ isPreview: file }, [{ id: 'ed', isPreview: tab }]))
      expect(previewReports(loaded), `file ${file}, tab ${tab}`).toContainEqual(
        expect.objectContaining({ table: demoted, before: true })
      )
      const saved = saveWorkspaceLayout(loaded)
      expect(saved.openFilesByWorktree![GIT_KEY]![0]!.isPreview).toBeUndefined()
      expect(saved.unifiedTabs![GIT_KEY]!.find((entry) => entry.id === 'ed')!.isPreview).toBeFalsy()
    }
  })

  it('keeps preview where both flags agree, and the file preview while any of its tabs is', () => {
    const stored = withEditorTabs({ isPreview: true }, [
      { id: 'ed', isPreview: true },
      { id: 'ed-2', isPreview: false }
    ])
    const loaded = load(stored)
    expect(previewReports(loaded)).toEqual([])
    const saved = saveWorkspaceLayout(loaded)
    expect(saved.openFilesByWorktree![GIT_KEY]![0]!.isPreview).toBe(true)
    expect(saved.unifiedTabs![GIT_KEY]!.find((entry) => entry.id === 'ed')!.isPreview).toBe(true)
    expect(load(saved).changes).toEqual([])
  })

  it("names an editor tab's file owner as its host, and reports a stored partition host", () => {
    const stored = withEditorTabs({ externalSshTargetId: 'box' }, [
      { id: 'ed', executionHostId: LOCAL_EXECUTION_HOST_ID }
    ])
    const loaded = load(stored)
    expect(loaded.changes).toEqual([
      {
        table: 'entry',
        record: `${GIT_KEY}|ed`,
        field: 'executionHostId',
        before: LOCAL_EXECUTION_HOST_ID,
        after: 'ssh:box'
      }
    ])
    const saved = saveWorkspaceLayout(loaded)
    expect(saved.unifiedTabs![GIT_KEY]!.find((entry) => entry.id === 'ed')!.executionHostId).toBe(
      'ssh:box'
    )
    expect(load(saved).changes).toEqual([])
  })

  it("reports a row whose stored terminal is not its focused pane's, then saves the pane's", () => {
    const stored = twoTabs()
    stored.tabsByWorktree[GIT_KEY]![0]!.ptyId = null
    const loaded = load(stored)
    expect(loaded.changes).toEqual([
      { table: 'row', record: `${GIT_KEY}|tab-a`, field: 'ptyId', before: null, after: 'pty-a' }
    ])
    expect(saveWorkspaceLayout(loaded).tabsByWorktree[GIT_KEY]![0]!.ptyId).toBe('pty-a')
  })

  it('re-mints the tab-bar id of a row whose own id another tab already uses, and reports it', () => {
    const stored = twoTabs()
    const [entryA, entryB] = stored.unifiedTabs![GIT_KEY]!
    stored.unifiedTabs![GIT_KEY] = [
      entryA!,
      { ...entryB!, entityId: '/w/b.ts', contentType: 'editor' }
    ]
    const loaded = load(stored)
    expect(changed(loaded)).toContain('terminalEntry.*')
    expect(checkWorkspaceLayoutModelRules([loaded.layout])).toEqual([])
  })

  it('applies a legacy surface tombstone once: the pane closes, the tombstone is cleared, authority stays', () => {
    const stored = twoTabs()
    stored.terminalSurfaceTombstonesByPaneKey = {
      [`tab-b:${leaf(2)}`]: {
        worktreeId: GIT_KEY,
        parentTabId: 'tab-b',
        leafId: leaf(2),
        ptyId: 'pty-b',
        incarnationId: 'inc',
        retiredAt: 1
      }
    }
    const saved = saveWorkspaceLayout(load(stored))
    expect(saved.terminalSurfaceTombstonesByPaneKey).toBeUndefined()
    expect(saved.tabsByWorktree[GIT_KEY]!.map((row) => row.id)).toEqual(['tab-a'])
    expect(saved.tabGroups![GIT_KEY]![0]!.tabOrder).toEqual(['tab-a'])
    expect(saved.terminalLayoutsByTabId['tab-b']).toBeUndefined()
    expect(saved.terminalTopologyRevisionByRepoId!['repo-1']).toBeGreaterThan(0)
    expect(load(saved).changes).toEqual([])
  })

  it('keeps a tombstone whose pane now shows another terminal from closing it', () => {
    const stored = twoTabs()
    stored.terminalSurfaceTombstonesByPaneKey = {
      [`tab-b:${leaf(2)}`]: {
        worktreeId: GIT_KEY,
        parentTabId: 'tab-b',
        leafId: leaf(2),
        ptyId: 'pty-old',
        incarnationId: 'inc',
        retiredAt: 1
      }
    }
    const saved = saveWorkspaceLayout(load(stored))
    expect(saved.tabsByWorktree[GIT_KEY]!.map((row) => row.id)).toEqual(['tab-a', 'tab-b'])
    expect(saved.terminalSurfaceTombstonesByPaneKey).toBeUndefined()
  })

  it('gives a legacy row with no pane layout one pane bound to its terminal, and reports it', () => {
    const stored = twoTabs()
    delete stored.terminalLayoutsByTabId['tab-b']
    const loaded = load(stored)
    expect(changed(loaded)).toEqual(['layout.*'])
    const saved = saveWorkspaceLayout(loaded)
    const leafId = saved.terminalLayoutsByTabId['tab-b']!.activeLeafId!
    expect(saved.terminalLayoutsByTabId['tab-b']).toEqual({
      root: { type: 'leaf', leafId },
      activeLeafId: leafId,
      expandedLeafId: null,
      ptyIdsByLeafId: { [leafId]: 'pty-b' }
    })
    expect(saved.tabsByWorktree[GIT_KEY]![1]!.ptyId).toBe('pty-b')
    expect(rules(saved)).toEqual([])
    expect(load(saved).changes).toEqual([])
  })

  it("reuses the legacy row's recorded pane, so its records and tombstone still apply", () => {
    const stored = twoTabs()
    delete stored.terminalLayoutsByTabId['tab-b']
    stored.terminalSurfaceTombstonesByPaneKey = {
      [`tab-b:${leaf(5)}`]: {
        worktreeId: GIT_KEY,
        parentTabId: 'tab-b',
        leafId: leaf(5),
        ptyId: 'pty-b',
        incarnationId: 'inc',
        retiredAt: 1
      }
    }
    const loaded = load(stored)
    // The tombstone closes the tab only because the new pane took the leaf it names.
    expect(changed(loaded)).toEqual(
      expect.arrayContaining(['row.*', 'session.terminalSurfaceTombstonesByPaneKey'])
    )
    expect(saveWorkspaceLayout(loaded).tabsByWorktree[GIT_KEY]!.map((row) => row.id)).toEqual([
      'tab-a'
    ])
  })

  it('drops the transient spawn handoff main’s minimal row mint stores, and reports it', () => {
    const stored = twoTabs()
    stored.tabsByWorktree[GIT_KEY]![0]!.pendingActivationSpawn = true
    const loaded = load(stored)
    expect(changed(loaded)).toEqual(['row.pendingActivationSpawn'])
    expect(saveWorkspaceLayout(loaded).tabsByWorktree[GIT_KEY]![0]).not.toHaveProperty(
      'pendingActivationSpawn'
    )
  })

  it('carries a pane layout with no terminal tab through unchanged', () => {
    const stored = twoTabs()
    stored.terminalLayoutsByTabId['tab-gone'] = {
      root: { type: 'leaf', leafId: leaf(7) },
      activeLeafId: leaf(7),
      expandedLeafId: null
    }
    const loaded = load(stored)
    expect(loaded.changes).toEqual([])
    const saved = saveWorkspaceLayout(loaded)
    expect(onDisk(saved)).toEqual(onDisk(stored))
    // Carried, not repaired: the rules check still reports it.
    expect(rules(saved)).toEqual(['pane_without_tab'])
  })
})
