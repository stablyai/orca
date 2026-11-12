// Verify disk effects: legacy row ownership/revision, distinct tab/terminal IDs and dirty-draft refusal on preview replacement.

import { describe, expect, it } from 'vitest'
import '../../execution-host'
import { applyLayoutCommand } from '../workspace-layout-commands'
import { build, testContext, WS } from '../commands/workspace-layout-command.test-fixture'
import './workspace-layout-load'
import type { WorkspaceLayoutModel } from '../workspace-layout-model'
import './workspace-layout-profile.test-fixture'
import './workspace-layout-save'
import './workspace-layout-session.test-fixture'

describe('the legacy persistence record through commands', () => {
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
