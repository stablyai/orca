// Verify disk effects: legacy row ownership/revision, distinct tab/terminal IDs and dirty-draft refusal on preview replacement.

import { describe, expect, it } from 'vitest'
import '../../execution-host/execution-host'
import { applyLayoutCommand } from '../workspace-layout-commands'
import { build, testContext, WS } from '../commands/workspace-layout-command.test-fixture'
import './workspace-layout-load'

import './workspace-layout-profile.test-fixture'
import './workspace-layout-save'
import './workspace-layout-session.test-fixture'

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
