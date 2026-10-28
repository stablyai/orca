import { describe, expect, it } from 'vitest'
import type { LayoutEditorView } from './layout-editor-view'
import { applyLayoutCommand } from './workspace-layout-commands'
import { build, testContext, WS } from './workspace-layout-command.test-fixture'
import { workspaceLayoutFromPublished } from './workspace-layout-from-published'
import type { WorkspaceLayoutModel } from './workspace-layout-model'
import { publishWorkspaceLayout, type PublishedWorkspaceLayout } from './workspace-layout-published'
import {
  applyWorkspaceLayoutRecordChange,
  diffPublishedLayouts,
  indexPublishedLayout
} from './workspace-layout-records'

const DIFF_ID = 'wt::diff::unstaged::src/a.ts'
const TO = 'wt-target'

const diffView = (diffSource: 'unstaged' | 'staged'): LayoutEditorView => ({
  view: { mode: 'diff', diffSource },
  file: {
    filePath: '/repo/src/a.ts',
    relativePath: 'src/a.ts',
    language: 'typescript',
    runtimeEnvironmentId: null
  }
})

function withDiffTab(view: LayoutEditorView = diffView('unstaged')): WorkspaceLayoutModel {
  return build(testContext(), [
    { type: 'createTerminalTab', workspace: WS },
    {
      type: 'openEditorTab',
      workspace: WS,
      tabId: DIFF_ID,
      fileId: DIFF_ID,
      contentType: 'diff',
      view
    }
  ]).model
}

function applied(model: WorkspaceLayoutModel, command: Parameters<typeof applyLayoutCommand>[1]) {
  const result = applyLayoutCommand(model, command, testContext())
  if (!result.ok) {
    throw new Error(result.code)
  }
  return result.model
}

const publish = (model: WorkspaceLayoutModel, key = WS): PublishedWorkspaceLayout =>
  publishWorkspaceLayout(model.workspaces[key]!, model.hostId)

describe("main publishes an editor tab's view", () => {
  it('carries a diff tab’s view on its tab, and a window reads it back', () => {
    const published = publish(withDiffTab())
    const diff = published.tabs.find((tab) => tab.entityId === DIFF_ID)!

    expect(diff.editorView).toEqual(diffView('unstaged'))
    expect(published.tabs.filter((tab) => tab.editorView)).toHaveLength(1)
    // A diff has no saved file record: the view is the only way to rebuild it.
    expect(published.editorFiles).toEqual([])
    expect(workspaceLayoutFromPublished(published).editorViews).toEqual({
      [diff.id]: diffView('unstaged')
    })
  })

  it('sends a changed view as a changed tab row', () => {
    const before = publish(withDiffTab())
    const after = publish(withDiffTab(diffView('staged')))

    const change = diffPublishedLayouts(
      WS,
      indexPublishedLayout(before),
      indexPublishedLayout(after),
      after
    )

    expect(change).toMatchObject({ change: 'records', tabs: { set: [{ id: DIFF_ID }] } })
    expect(change && Object.keys(change).sort()).toEqual(['change', 'key', 'tabs'])
    const shown = applyWorkspaceLayoutRecordChange(before, change!)
    expect(shown?.tabs.find((tab) => tab.id === DIFF_ID)?.editorView).toEqual(diffView('staged'))
  })

  it('keeps the view on a tab rekeyed by a rename', () => {
    const renamedId = 'wt::diff::unstaged::src/b.ts'
    const renamed = applied(withDiffTab(), {
      type: 'renameEditorFiles',
      workspace: WS,
      renames: [{ fileId: DIFF_ID, newFileId: renamedId }]
    })

    const diff = publish(renamed).tabs.find((tab) => tab.kind === 'diff')!
    expect(diff).toMatchObject({ id: renamedId, entityId: renamedId })
    expect(diff.editorView).toEqual(diffView('unstaged'))
  })

  it('keeps the view on a tab moved to another workspace', () => {
    const newId = `${TO}::diff::unstaged::src/a.ts`
    const moved = applied(withDiffTab(), {
      type: 'moveTabToWorkspace',
      workspace: WS,
      toWorkspace: TO,
      tabs: [{ tabId: DIFF_ID, newTabId: newId, newEntityId: newId }],
      groupId: 'target-group'
    })

    expect(publish(moved).tabs.some((tab) => tab.editorView)).toBe(false)
    const diff = publish(moved, TO).tabs.find((tab) => tab.id === newId)!
    expect(diff.editorView).toEqual(diffView('unstaged'))
  })
})
