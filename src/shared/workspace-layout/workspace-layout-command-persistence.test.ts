// Commands against what reaches disk: the legacy row-ownership marker and revision, a terminal tab
// whose tab-bar id and terminal id differ, and the unsaved-draft refusal on preview replacement.

import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../execution-host'
import { applyLayoutCommand } from './workspace-layout-commands'
import { asLoaded, build, testContext, WS } from './workspace-layout-command.test-fixture'
import { loadWorkspaceLayout } from './workspace-layout-load'
import type { WorkspaceLayoutModel } from './workspace-layout-model'
import { localDesktopSession } from './workspace-layout-profile.test-fixture'
import { saveWorkspaceLayout } from './workspace-layout-save'
import { GIT_KEY, leaf } from './workspace-layout-session.test-fixture'
import type { WorkspaceSessionState } from '../workspace-session-state-types'

function reload(session: WorkspaceSessionState) {
  let next = 0
  const loaded = loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, session, {
    mintId: () => `reload-${++next}`,
    mintLeafId: () => `00000000-0000-4000-9000-${String(++next).padStart(12, '0')}`
  })
  expect(loaded.changes).toEqual([])
  return loaded
}

const save = (model: WorkspaceLayoutModel) => saveWorkspaceLayout(asLoaded(model))

describe('the legacy persistence record through commands', () => {
  it('keeps an emptied row list after create then close, with or without a reload between', () => {
    const context = testContext()
    const created = build(context, [{ type: 'createTerminalTab', workspace: WS }])
    const tabId = created.results[0]!.tabId!
    expect(created.model.legacy).toEqual({
      terminalRowOwners: { [WS]: true },
      topologyRevisionByRepoId: { 'repo-1': 1 }
    })
    const close = { type: 'closeTabs' as const, workspace: WS, tabIds: [tabId] }
    const direct = build(context, [close], created.model).model
    const reopened = reload(save(created.model)).layout
    const afterReload = build(context, [close], reopened).model
    for (const closed of [direct, afterReload]) {
      const saved = save(closed)
      expect(saved.tabsByWorktree).toEqual({ [WS]: [] })
      expect(saved.terminalTopologyRevisionByRepoId).toEqual({ 'repo-1': 2 })
      expect(reload(saved).layout.legacy.terminalRowOwners).toEqual({ [WS]: true })
    }
  })

  it('advances the revision only for commands that change terminal panes', () => {
    const context = testContext()
    const { model, results } = build(context, [
      { type: 'createTerminalTab', workspace: WS },
      { type: 'createTerminalTab', workspace: WS }
    ])
    const revision = (next: WorkspaceLayoutModel) => next.legacy.topologyRevisionByRepoId
    expect(revision(model)).toEqual({ 'repo-1': 2 })
    const group = model.workspaces[WS]!.groups[0]!.id
    const tabId = results[0]!.tabId!
    const moved = build(
      context,
      [{ type: 'moveTab', workspace: WS, tabId, toGroupId: group, index: 1 }],
      model
    )
    expect(revision(moved.model)).toEqual({ 'repo-1': 2 })
    const leafId = results[0]!.leafId!
    const split = build(
      context,
      [{ type: 'splitPane', workspace: WS, tabId, leafId, direction: 'vertical' }],
      model
    )
    expect(revision(split.model)).toEqual({ 'repo-1': 3 })
  })
})

describe('a terminal tab whose tab-bar id and terminal id differ', () => {
  it('takes commands by its tab-bar id and saves pane records under its terminal id', () => {
    const context = testContext()
    const loaded = reload(localDesktopSession())
    const model = loaded.layout
    const split = build(
      context,
      [
        {
          type: 'splitPane',
          workspace: GIT_KEY,
          tabId: 'tab-agent',
          leafId: leaf(3),
          direction: 'vertical'
        }
      ],
      model
    )
    const newLeaf = split.results[0]!.leafId!
    expect(split.results[0]!.paneKey).toBe(`term-agent:${newLeaf}`)
    const record = loaded.layout.workspaces[GIT_KEY]!.leaves![leaf(3)]!.sleeping!
    const slept = build(
      context,
      [
        { type: 'wake', workspace: GIT_KEY, paneKeys: [`term-agent:${leaf(3)}`] },
        {
          type: 'sleep',
          workspace: GIT_KEY,
          paneKeys: [`term-agent:${newLeaf}`],
          records: [
            {
              ...record,
              paneKey: `term-agent:${newLeaf}`,
              tabId: 'term-agent',
              worktreeId: GIT_KEY
            }
          ]
        },
        {
          type: 'renamePane',
          workspace: GIT_KEY,
          tabId: 'tab-agent',
          leafId: newLeaf,
          title: 'logs'
        }
      ],
      split.model
    )
    const saved = saveWorkspaceLayout({ ...loaded, layout: slept.model })
    expect(Object.keys(saved.sleepingAgentSessionsByPaneKey!)).toEqual([`term-agent:${newLeaf}`])
    expect(saved.sleepingAgentSessionsByPaneKey![`term-agent:${newLeaf}`]).toMatchObject({
      paneKey: `term-agent:${newLeaf}`,
      tabId: 'term-agent'
    })
    expect(saved.terminalLayoutsByTabId['term-agent']!.titlesByLeafId).toEqual({
      [newLeaf]: 'logs'
    })
    expect(saved.terminalPtyIncarnationsByPaneKey![`term-agent:${leaf(3)}`]).toBe('inc-3')
    expect(saved.unifiedTabs![GIT_KEY]!.find((tab) => tab.entityId === 'term-agent')!.id).toBe(
      'tab-agent'
    )
    const dragged = build(
      context,
      [{ type: 'movePaneToNewTab', workspace: GIT_KEY, tabId: 'tab-agent', leafId: newLeaf }],
      slept.model
    )
    const draggedTab = dragged.results[0]!.tabId!
    const afterDrag = reload(saveWorkspaceLayout({ ...loaded, layout: dragged.model }))
    const resaved = saveWorkspaceLayout(afterDrag)
    expect(Object.keys(resaved.sleepingAgentSessionsByPaneKey!)).toEqual([
      `${draggedTab}:${newLeaf}`
    ])
    const closed = build(
      context,
      [{ type: 'closeTabs', workspace: GIT_KEY, tabIds: ['tab-agent'] }],
      afterDrag.layout
    )
    const final = saveWorkspaceLayout({ ...afterDrag, layout: closed.model })
    expect(final.terminalLayoutsByTabId['term-agent']).toBeUndefined()
    expect(final.terminalPtyIncarnationsByPaneKey![`term-agent:${leaf(3)}`]).toBeUndefined()
  })
})

describe('preview replacement', () => {
  it('keeps a preview with an unsaved draft and opens beside it, refused as closeTabs refuses', () => {
    const context = testContext()
    const open = (fileId: string, dirtyTabIds?: string[]) => ({
      type: 'openEditorTab' as const,
      workspace: WS,
      fileId,
      contentType: 'editor' as const,
      preview: true,
      ...(dirtyTabIds ? { dirtyTabIds } : {})
    })
    const first = build(context, [open('/w/a.ts')])
    const previewId = first.results[0]!.tabId!
    const refused = applyLayoutCommand(first.model, open('/w/b.ts', [previewId]), context)
    expect(refused.ok && refused.result.refused).toEqual([
      { tabId: previewId, code: 'editor_tab_has_unsaved_draft' }
    ])
    expect(refused.ok && refused.model.workspaces[WS]!.tabs.map((tab) => tab.entityId)).toEqual([
      '/w/a.ts',
      '/w/b.ts'
    ])
    const clean = build(context, [open('/w/b.ts')], first.model)
    expect(clean.model.workspaces[WS]!.tabs.map((tab) => tab.entityId)).toEqual(['/w/b.ts'])
  })
})
