import { describe, expect, it } from 'vitest'
import { applyLayoutCommand } from './workspace-layout-commands'
import type { CommandOf } from './workspace-layout-command-types'
import { build, testContext, WS } from './workspace-layout-command.test-fixture'
import type { WorkspaceLayoutModel } from './workspace-layout-model'

const TO = 'wt-target'
const PATH = '/target/docs/readme.md'
const NEW_ID = `editor:${encodeURIComponent(TO)}:local:${encodeURIComponent(PATH)}`
const FILE = { filePath: PATH, relativePath: 'docs/readme.md', language: 'markdown' }

/** The source holds a terminal and the restored editor tab; the target one editor tab. */
function twoWorkspaces() {
  const ctx = testContext()
  const source = build(ctx, [
    { type: 'createTerminalTab', workspace: WS },
    {
      type: 'openEditorTab',
      workspace: WS,
      tabId: PATH,
      fileId: PATH,
      contentType: 'editor',
      file: { ...FILE, relativePath: PATH }
    }
  ])
  const target = build(
    ctx,
    [
      {
        type: 'openEditorTab',
        workspace: TO,
        tabId: 'target-tab',
        fileId: '/target/a.ts',
        contentType: 'editor',
        groupId: 'target-group'
      }
    ],
    source.model
  )
  return { ctx, model: target.model, terminal: source.results[0]!.tabId! }
}

const move = (
  fields: Partial<CommandOf<'moveTabToWorkspace'>> = {}
): CommandOf<'moveTabToWorkspace'> => ({
  type: 'moveTabToWorkspace',
  workspace: WS,
  toWorkspace: TO,
  tabs: [{ tabId: PATH, newTabId: NEW_ID, newEntityId: NEW_ID }],
  groupId: 'target-group',
  file: FILE,
  ...fields
})

function tabsOf(model: WorkspaceLayoutModel, key: string) {
  const workspace = model.workspaces[key]!
  return workspace.groups.map((group) => ({
    group: group.id,
    tabs: group.tabOrder.map((id) => {
      const tab = workspace.tabs.find((entry) => entry.id === id)!
      return `${tab.id}=${tab.entityId}`
    })
  }))
}

describe('moveTabToWorkspace', () => {
  it("appends the tab to the window's group under its new ids, and moves the file's record", () => {
    const { ctx, model, terminal } = twoWorkspaces()

    // `build` also checks every structural rule on the result.
    const moved = build(ctx, [move()], model)

    expect(moved.results[0]).toEqual({ tabId: NEW_ID, groupId: 'target-group' })
    expect(tabsOf(moved.model, TO)).toEqual([
      { group: 'target-group', tabs: ['target-tab=/target/a.ts', `${NEW_ID}=${NEW_ID}`] }
    ])
    expect(tabsOf(moved.model, WS)).toEqual([
      { group: expect.any(String), tabs: [`${terminal}=${terminal}`] }
    ])
    expect(moved.model.workspaces[TO]!.editorFiles).toEqual([FILE])
    expect(moved.model.workspaces[WS]!.editorFiles).toEqual([])
  })

  it('keeps the tab id that does not name the file, and carries pin and title', () => {
    const { ctx, model } = twoWorkspaces()
    const pinned = applyLayoutCommand(
      model,
      { type: 'setTabProps', workspace: WS, tabId: PATH, isPinned: true, color: 'red' },
      ctx
    )
    if (!pinned.ok) {
      throw new Error(pinned.code)
    }

    const moved = applyLayoutCommand(
      pinned.model,
      move({ tabs: [{ tabId: PATH, newTabId: PATH, newEntityId: NEW_ID }] }),
      ctx
    )

    if (!moved.ok) {
      throw new Error(moved.code)
    }
    expect(moved.model.workspaces[TO]!.tabs.find((tab) => tab.id === PATH)).toMatchObject({
      entityId: NEW_ID,
      isPinned: true,
      color: 'red'
    })
    // Appended as the window appends it, even pinned.
    expect(tabsOf(moved.model, TO)[0]!.tabs.at(-1)).toBe(`${PATH}=${NEW_ID}`)
  })

  it('moves a dependent preview tab after its source, in the order sent', () => {
    const { ctx, model } = twoWorkspaces()
    const withPreview = applyLayoutCommand(
      model,
      {
        type: 'openEditorTab',
        workspace: WS,
        tabId: 'preview-tab',
        fileId: `markdown-preview::${PATH}`,
        contentType: 'editor'
      },
      ctx
    )
    if (!withPreview.ok) {
      throw new Error(withPreview.code)
    }

    const moved = applyLayoutCommand(
      withPreview.model,
      move({
        tabs: [
          { tabId: PATH, newTabId: NEW_ID, newEntityId: NEW_ID },
          {
            tabId: 'preview-tab',
            newTabId: 'preview-tab',
            newEntityId: `markdown-preview::${NEW_ID}`
          }
        ]
      }),
      ctx
    )

    if (!moved.ok) {
      throw new Error(moved.code)
    }
    expect(tabsOf(moved.model, TO)[0]!.tabs).toEqual([
      'target-tab=/target/a.ts',
      `${NEW_ID}=${NEW_ID}`,
      `preview-tab=markdown-preview::${NEW_ID}`
    ])
    expect(moved.result.tabId).toBe('preview-tab')
  })

  it("closes the source's emptied group and gives a target with no group the window's", () => {
    const ctx = testContext()
    const source = build(ctx, [
      { type: 'openEditorTab', workspace: WS, tabId: PATH, fileId: PATH, contentType: 'editor' }
    ])

    const moved = applyLayoutCommand(source.model, move({ groupId: 'window-group' }), ctx)

    if (!moved.ok) {
      throw new Error(moved.code)
    }
    expect(moved.model.workspaces[WS]!.groups).toEqual([])
    expect(tabsOf(moved.model, TO)).toEqual([
      { group: 'window-group', tabs: [`${NEW_ID}=${NEW_ID}`] }
    ])
  })

  it('carries what the tab shows beyond its file', () => {
    const { ctx, model } = twoWorkspaces()
    const view = { mode: 'diff' } as const
    const withView: WorkspaceLayoutModel = {
      ...model,
      workspaces: {
        ...model.workspaces,
        [WS]: { ...model.workspaces[WS]!, editorViews: { [PATH]: view } }
      }
    }

    const moved = applyLayoutCommand(withView, move(), ctx)

    if (!moved.ok) {
      throw new Error(moved.code)
    }
    expect(moved.model.workspaces[WS]!.editorViews).toEqual({})
    expect(moved.model.workspaces[TO]!.editorViews).toEqual({ [NEW_ID]: view })
  })

  it('changes nothing for a move already saved, and refuses what main cannot match', () => {
    const { ctx, model } = twoWorkspaces()
    const moved = applyLayoutCommand(model, move(), ctx)
    if (!moved.ok) {
      throw new Error(moved.code)
    }

    const again = applyLayoutCommand(moved.model, move(), ctx)
    expect(again.ok && again.model).toEqual(moved.model)

    expect(applyLayoutCommand(model, move({ groupId: 'other-group' }), ctx)).toEqual({
      ok: false,
      code: 'group_not_found'
    })
    expect(
      applyLayoutCommand(
        model,
        move({ tabs: [{ tabId: 'missing', newTabId: 'x', newEntityId: 'x' }] }),
        ctx
      )
    ).toEqual({ ok: false, code: 'tab_not_found' })
    expect(
      applyLayoutCommand(
        model,
        move({ tabs: [{ tabId: PATH, newTabId: 'target-tab', newEntityId: NEW_ID }] }),
        ctx
      )
    ).toEqual({ ok: false, code: 'tab_exists' })
    const twice = { tabId: PATH, newTabId: NEW_ID, newEntityId: NEW_ID }
    expect(applyLayoutCommand(model, move({ tabs: [twice, twice] }), ctx)).toEqual({
      ok: false,
      code: 'invalid_params'
    })
    expect(applyLayoutCommand(model, move({ toWorkspace: WS }), ctx)).toEqual({
      ok: false,
      code: 'invalid_params'
    })
    expect(applyLayoutCommand(model, move({ workspace: 'unknown' }), ctx)).toEqual({
      ok: false,
      code: 'workspace_not_found'
    })
  })

  it('refuses a terminal tab, whose panes would not follow it', () => {
    const { ctx, model, terminal } = twoWorkspaces()

    expect(
      applyLayoutCommand(
        model,
        move({ tabs: [{ tabId: terminal, newTabId: terminal, newEntityId: terminal }] }),
        ctx
      )
    ).toEqual({ ok: false, code: 'invalid_params' })
  })
})
