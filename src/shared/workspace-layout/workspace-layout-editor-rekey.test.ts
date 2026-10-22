import { describe, expect, it } from 'vitest'
import { applyLayoutCommand } from './workspace-layout-commands'
import { build, testContext, WS } from './workspace-layout-command.test-fixture'
import type { EditorFileRename } from './workspace-layout-command-types'
import type { LayoutEditorFile, WorkspaceLayoutModel } from './workspace-layout-model'
import { checkWorkspaceLayoutModelRules } from './workspace-layout-model-rules'

const file = (filePath: string): LayoutEditorFile => ({
  filePath,
  relativePath: filePath.replace('/repo/', ''),
  language: 'typescript'
})

const DIFF_A = 'wt::diff::unstaged::a.ts'

/** Editor tabs for a.ts and b.ts, a diff of a.ts, and a terminal. */
function setup() {
  return build(testContext(), [
    { type: 'createTerminalTab', workspace: WS },
    ...['/repo/a.ts', '/repo/b.ts'].map((path) => ({
      type: 'openEditorTab' as const,
      workspace: WS,
      fileId: path,
      contentType: 'editor' as const,
      file: file(path)
    })),
    { type: 'openEditorTab', workspace: WS, fileId: DIFF_A, contentType: 'diff' }
  ]).model
}

function edit(from: string, to: string, newFileId = to): EditorFileRename {
  return { fileId: from, newFileId, record: { fromFilePath: from, file: file(to) } }
}

function rename(model: WorkspaceLayoutModel, renames: EditorFileRename[]) {
  const result = applyLayoutCommand(
    model,
    { type: 'renameEditorFiles', workspace: WS, renames },
    testContext()
  )
  if (result.ok) {
    expect(checkWorkspaceLayoutModelRules([result.model], [model])).toEqual([])
  }
  return result
}

const editors = (model: WorkspaceLayoutModel) => ({
  tabs: model.workspaces[WS]!.tabs.flatMap((tab) =>
    tab.kind === 'terminal' ? [] : [tab.entityId]
  ),
  files: model.workspaces[WS]!.editorFiles!.map((entry) => [entry.filePath, entry.relativePath])
})

describe('editor tabs follow a file renamed on disk', () => {
  it("rekeys tabs and file records under the window's ids, keeping tab-bar ids and order", () => {
    const model = setup()
    const before = model.workspaces[WS]!
    const owned = 'editor:wt:local:%2Frepo%2Fsrc%2Fa.ts'
    const result = rename(model, [
      edit('/repo/a.ts', '/repo/src/a.ts', owned),
      { fileId: DIFF_A, newFileId: 'wt::diff::unstaged::src/a.ts' }
    ])
    expect(result.ok && editors(result.model)).toEqual({
      tabs: [owned, '/repo/b.ts', 'wt::diff::unstaged::src/a.ts'],
      files: [
        ['/repo/src/a.ts', 'src/a.ts'],
        ['/repo/b.ts', 'b.ts']
      ]
    })
    expect(result.ok && result.model.workspaces[WS]!.groups).toEqual(before.groups)
    expect(result.ok && result.result.renamedTabIds).toEqual({})
  })

  it('swaps two open files, and rekeys back on a rollback rename', () => {
    const model = setup()
    const swapped = rename(model, [
      edit('/repo/a.ts', '/repo/b.ts'),
      edit('/repo/b.ts', '/repo/a.ts')
    ])
    expect(swapped.ok && editors(swapped.model).tabs).toEqual(['/repo/b.ts', '/repo/a.ts', DIFF_A])
    const moved = rename(model, [edit('/repo/a.ts', '/repo/c.ts')])
    const back = moved.ok && rename(moved.model, [edit('/repo/c.ts', '/repo/a.ts')])
    expect(back && back.ok && editors(back.model)).toEqual(editors(model))
  })

  it('never merges two open files, and changes nothing for a file none shows', () => {
    const model = setup()
    expect(rename(model, [edit('/repo/a.ts', '/repo/b.ts')])).toEqual({
      ok: false,
      code: 'invalid_params'
    })
    expect(
      rename(model, [edit('/repo/a.ts', '/repo/c.ts'), edit('/repo/b.ts', '/repo/c.ts')])
    ).toEqual({ ok: false, code: 'invalid_params' })
    const closed = rename(model, [{ fileId: '/repo/x.ts', newFileId: '/repo/y.ts' }])
    expect(closed.ok && closed.model).toEqual(model)
    const unshown = rename(model, [edit('/repo/x.ts', '/repo/y.ts')])
    expect(unshown.ok && unshown.model).toEqual(model)
    // A record main lacks for a tab it shows is the window's now.
    const workspace = model.workspaces[WS]!
    const unrecorded = {
      ...model,
      workspaces: {
        [WS]: {
          ...workspace,
          editorFiles: workspace.editorFiles!.filter((entry) => entry.filePath !== '/repo/a.ts')
        }
      }
    }
    const recorded = rename(unrecorded, [edit('/repo/a.ts', '/repo/c.ts')])
    expect(recorded.ok && editors(recorded.model).files).toContainEqual(['/repo/c.ts', 'c.ts'])
  })

  it('moves a tab-bar id that is the file id with it, in the tab order too', () => {
    const model = setup()
    const workspace = model.workspaces[WS]!
    const tabId = workspace.tabs.find((tab) => tab.entityId === '/repo/a.ts')!.id
    const pathIds: WorkspaceLayoutModel = {
      ...model,
      workspaces: {
        [WS]: {
          ...workspace,
          tabs: workspace.tabs.map((tab) =>
            tab.id === tabId ? { ...tab, id: '/repo/a.ts' } : tab
          ),
          groups: workspace.groups.map((group) => ({
            ...group,
            tabOrder: group.tabOrder.map((id) => (id === tabId ? '/repo/a.ts' : id))
          }))
        }
      }
    }
    const result = rename(pathIds, [edit('/repo/a.ts', '/repo/c.ts')])
    expect(result.ok && result.model.workspaces[WS]!.groups[0]!.tabOrder).toContain('/repo/c.ts')
    expect(
      result.ok && result.model.workspaces[WS]!.tabs.some((tab) => tab.id === '/repo/c.ts')
    ).toBe(true)
    expect(result.ok && result.result.renamedTabIds).toEqual({ '/repo/a.ts': '/repo/c.ts' })
  })

  it("gives a renamed view tab its file's new path, and leaves other views alone", () => {
    const model = setup()
    const diffTab = model.workspaces[WS]!.tabs.find((tab) => tab.entityId === DIFF_A)!
    const oldView = { view: { mode: 'diff' as const }, file: file('/repo/a.ts') }
    const withView: WorkspaceLayoutModel = {
      ...model,
      workspaces: {
        [WS]: { ...model.workspaces[WS]!, editorViews: { [diffTab.id]: oldView } }
      }
    }
    const newDiff = 'wt::diff::unstaged::src/a.ts'
    const newView = { view: { mode: 'diff' as const }, file: file('/repo/src/a.ts') }

    const result = rename(withView, [{ fileId: DIFF_A, newFileId: newDiff, view: newView }])

    expect(result.ok && result.model.workspaces[WS]!.editorViews).toEqual({
      [diffTab.id]: newView
    })
    const untouched = rename(withView, [edit('/repo/b.ts', '/repo/c.ts')])
    expect(untouched.ok && untouched.model.workspaces[WS]!.editorViews).toEqual({
      [diffTab.id]: oldView
    })
  })
})

describe("one disk move's renames across workspaces", () => {
  const OTHER = 'other-ws'

  /** a.ts open in WS and in a second workspace of the same partition. */
  function twoWorkspaces(): WorkspaceLayoutModel {
    return build(
      testContext(),
      [
        {
          type: 'openEditorTab',
          workspace: OTHER,
          tabId: 'other-a',
          fileId: '/repo/a.ts',
          contentType: 'editor',
          file: file('/repo/a.ts')
        },
        {
          type: 'openEditorTab',
          workspace: OTHER,
          tabId: 'other-c',
          fileId: '/repo/c.ts',
          contentType: 'editor',
          file: file('/repo/c.ts')
        }
      ],
      setup()
    ).model
  }

  const both = (otherRenames: EditorFileRename[]) => ({
    type: 'renameEditorFiles' as const,
    workspace: WS,
    renames: [edit('/repo/a.ts', '/repo/src/a.ts')],
    alsoIn: [{ workspace: OTHER, renames: otherRenames }]
  })

  it('renames both workspaces in one change', () => {
    const model = twoWorkspaces()
    const result = applyLayoutCommand(
      model,
      both([edit('/repo/a.ts', '/repo/src/a.ts')]),
      testContext()
    )
    if (!result.ok) {
      throw new Error(result.code)
    }
    expect(checkWorkspaceLayoutModelRules([result.model], [model])).toEqual([])
    for (const key of [WS, OTHER]) {
      expect(result.model.workspaces[key]?.tabs.map((tab) => tab.entityId)).toContain(
        '/repo/src/a.ts'
      )
    }
  })

  it('changes neither when one workspace refuses', () => {
    // OTHER would take c.ts's id, which an open file holds.
    expect(
      applyLayoutCommand(twoWorkspaces(), both([edit('/repo/a.ts', '/repo/c.ts')]), testContext())
    ).toEqual({ ok: false, code: 'invalid_params' })
    expect(
      applyLayoutCommand(
        twoWorkspaces(),
        {
          ...both([]),
          alsoIn: [{ workspace: 'missing', renames: [edit('/repo/a.ts', '/repo/b.ts')] }]
        },
        testContext()
      )
    ).toEqual({ ok: false, code: 'workspace_not_found' })
  })
})
