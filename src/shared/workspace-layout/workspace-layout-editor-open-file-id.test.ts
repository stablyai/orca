import { describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../constants'
import { ownedEditorFileId } from '../workspace-session-pane-ownership'
import { build, emptyModel, testContext, WS } from './workspace-layout-command.test-fixture'
import { applyLayoutCommand } from './workspace-layout-commands'
import { editorOpenFileId } from './workspace-layout-editor-open-file-id'
import type { LayoutEditorFile, WorkspaceLayout } from './workspace-layout-model'

vi.mock('../layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const WT = 'repo-1::/repo'

function file(filePath: string, runtimeEnvironmentId?: string): LayoutEditorFile {
  return {
    filePath,
    relativePath: filePath.slice(1),
    language: 'typescript',
    ...(runtimeEnvironmentId ? { runtimeEnvironmentId } : {})
  }
}

function workspace(
  worktreeId: string,
  editorFiles: LayoutEditorFile[],
  entityIds: string[] = []
): WorkspaceLayout {
  return {
    worktreeId,
    tabs: entityIds.map((entityId, index) => ({
      id: `tab-${index}`,
      kind: 'editor',
      entityId,
      createdAt: 1,
      customTitle: null,
      color: null
    })),
    groups: [{ id: 'g1', tabOrder: entityIds.map((_, index) => `tab-${index}`) }],
    editorFiles
  }
}

describe('the file id main gives a file it opens', () => {
  it('is the owned id of a file no tab shows, never the bare path another host may hold', () => {
    expect(editorOpenFileId(workspace(WT, []), file('/repo/a.ts'))).toBe(
      ownedEditorFileId('/repo/a.ts', WT, null)
    )
  })

  it("is the id a tab already shows the same owner's file under, the bare path included", () => {
    expect(
      editorOpenFileId(workspace(WT, [file('/repo/a.ts')], ['/repo/a.ts']), file('/repo/a.ts'))
    ).toBe('/repo/a.ts')
  })

  it("is not the id another owner's tab shows for the same path", () => {
    const held = workspace(WT, [file('/repo/a.ts', 'env-1')], ['/repo/a.ts'])
    expect(editorOpenFileId(held, file('/repo/a.ts'))).toBe(
      ownedEditorFileId('/repo/a.ts', WT, null)
    )
  })

  it('is an owned id in the floating workspace', () => {
    expect(
      editorOpenFileId(workspace(FLOATING_TERMINAL_WORKTREE_ID, []), file('/tmp/notes.md'))
    ).toBe(ownedEditorFileId('/tmp/notes.md', FLOATING_TERMINAL_WORKTREE_ID, null))
  })
})

describe('an open main makes itself, naming the file but not its id', () => {
  const opened = file('/repo/a.ts')

  it('opens the file under its owned id', () => {
    const { model, results } = build(testContext(), [
      { type: 'openEditorTab', workspace: WS, contentType: 'editor', file: opened }
    ])
    const tab = model.workspaces[WS]!.tabs.find((entry) => entry.id === results[0]!.tabId)
    expect(tab?.entityId).toBe(ownedEditorFileId('/repo/a.ts', WS, null))
    expect(model.workspaces[WS]!.editorFiles).toEqual([opened])
  })

  it('shows the tab it already has for the file in that group', () => {
    const { results } = build(testContext(), [
      { type: 'openEditorTab', workspace: WS, contentType: 'editor', file: opened },
      { type: 'openEditorTab', workspace: WS, contentType: 'editor', file: opened }
    ])
    expect(results[1]!.tabId).toBe(results[0]!.tabId)
  })

  it('is refused naming neither the file nor its id', () => {
    const applied = applyLayoutCommand(
      emptyModel(),
      { type: 'openEditorTab', workspace: WS, contentType: 'editor' },
      testContext()
    )
    expect(applied).toEqual({ ok: false, code: 'invalid_params' })
  })
})
