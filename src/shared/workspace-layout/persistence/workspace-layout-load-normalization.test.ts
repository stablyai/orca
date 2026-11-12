// Exercise each legacy Loader normalization; fields outside its rule must survive unchanged.

import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../execution-host'
import type { WorkspaceSessionState } from '../../workspace-session/workspace-session-state-types'
import { loadWorkspaceLayout } from './workspace-layout-load'
import '../invariants/workspace-layout-model-rules'
import '../invariants/workspace-layout-rules'
import { checkLayoutRoundTrip } from './workspace-layout-round-trip-check'
import { saveWorkspaceLayout } from './workspace-layout-save'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  leaf,
  SSH_KEY
} from './workspace-layout-session.test-fixture'
import './workspace-layout-profile.test-fixture'

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

describe('Loader precedence for stored data that disagrees with itself, and its change report', () => {
  it('keeps a tab in the group its tab-bar entry names, as the window does', () => {
    const stored = addWorkspace(emptySession(), GIT_KEY, [
      { id: 'g1', tabs: [{ id: 'tab-a', leaves: [[leaf(1), 'pty-a']] }] },
      { id: 'g2', tabs: [{ id: 'tab-b', leaves: [[leaf(2), 'pty-b']] }] },
      { id: 'g3', tabs: [{ id: 'tab-c', leaves: [[leaf(3), 'pty-c']] }] }
    ])
    // An earlier group also lists tab-b; tab-c's entry names g1, which does not list it.
    stored.tabGroups![GIT_KEY]![0]!.tabOrder.push('tab-b')
    stored.unifiedTabs![GIT_KEY]![2]!.groupId = 'g1'
    const groups = load(stored).layout.workspaces[GIT_KEY]!.groups
    expect(groups.map((group) => [group.id, group.tabOrder])).toEqual([
      ['g1', ['tab-a', 'tab-c']],
      ['g2', ['tab-b']]
    ])
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
})
