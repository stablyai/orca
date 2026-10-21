import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../execution-host'
import { moveGroupLeafBeside } from './tab-group-layout-tree'
import { applyLayoutCommand } from './workspace-layout-commands'
import type { CommandOf, LayoutCommand, NewGroupSplit } from './workspace-layout-command-types'
import { asLoaded, build, testContext, WS } from './workspace-layout-command.test-fixture'
import { loadWorkspaceLayout } from './workspace-layout-load'
import { saveWorkspaceLayout } from './workspace-layout-save'

const editor = (
  fileId: string,
  fields: Partial<CommandOf<'openEditorTab'>> = {}
): CommandOf<'openEditorTab'> => ({
  type: 'openEditorTab',
  workspace: WS,
  fileId,
  contentType: 'editor',
  ...fields
})

const right: NewGroupSplit = { besideGroupId: 'g1', direction: 'right' }

/** One group, `g1`, holding `/w/a.ts` (permanent) and `/w/p.ts` (preview). */
function oneGroup() {
  const ctx = testContext()
  const { model } = build(ctx, [
    editor('/w/a.ts', { tabId: 'a', groupId: 'g1' }),
    editor('/w/p.ts', { tabId: 'p', groupId: 'g1', preview: true })
  ])
  return { ctx, model }
}

function groupsOf(model: ReturnType<typeof oneGroup>['model']) {
  return model.workspaces[WS]!.groups.map(({ id, tabOrder }) => ({ id, tabOrder }))
}

describe('opening into a new split', () => {
  it.each<[string, LayoutCommand]>([
    [
      'terminal',
      {
        type: 'createTerminalTab',
        workspace: WS,
        tabId: 'new',
        leafId: '00000000-0000-4000-8000-0000000000aa',
        groupId: 'g2',
        split: right
      }
    ],
    ['editor', editor('/w/b.ts', { tabId: 'new', groupId: 'g2', split: right })],
    [
      'browser',
      {
        type: 'openBrowserTab',
        workspace: WS,
        tabId: 'new',
        browserTabId: 'new',
        pageId: 'page',
        groupId: 'g2',
        index: 0,
        split: right
      }
    ]
  ])('makes the %s tab and its group in one step, beside the source', (_kind, command) => {
    const { ctx, model } = oneGroup()

    const opened = build(ctx, [command], model)

    expect(opened.results[0]!.tabId).toBe('new')
    expect(groupsOf(opened.model)).toEqual([
      { id: 'g1', tabOrder: ['a', 'p'] },
      { id: 'g2', tabOrder: ['new'] }
    ])
    // The window's split: the same tree helper it and splitGroup build with.
    expect(opened.model.workspaces[WS]!.groupLayout).toEqual(
      moveGroupLeafBeside({ type: 'leaf', groupId: 'g1' }, 'g2', 'g1', 'right')
    )
  })

  it("keeps the source's tab for the file and its preview", () => {
    const { ctx, model } = oneGroup()

    const opened = build(
      ctx,
      [editor('/w/a.ts', { tabId: 'a2', groupId: 'g2', preview: true, split: right })],
      model
    )

    expect(groupsOf(opened.model)).toEqual([
      { id: 'g1', tabOrder: ['a', 'p'] },
      { id: 'g2', tabOrder: ['a2'] }
    ])
    expect(opened.model.workspaces[WS]!.tabs.find((tab) => tab.id === 'p')!.isPreview).toBe(true)
  })

  it('nests a split beside a group that is already split', () => {
    const { ctx, model } = oneGroup()
    const twice = build(
      ctx,
      [
        editor('/w/b.ts', { tabId: 'b', groupId: 'g2', split: right }),
        editor('/w/c.ts', {
          tabId: 'c',
          groupId: 'g3',
          split: { besideGroupId: 'g2', direction: 'down' }
        })
      ],
      model
    )

    expect(twice.model.workspaces[WS]!.groupLayout).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'g1' },
      second: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', groupId: 'g2' },
        second: { type: 'leaf', groupId: 'g3' },
        ratio: 0.5
      },
      ratio: 0.5
    })
  })

  it('splits off a whole branch named by its first and last groups', () => {
    const { ctx, model } = oneGroup()
    const opened = build(
      ctx,
      [
        editor('/w/b.ts', { tabId: 'b', groupId: 'g2', split: right }),
        editor('/w/c.ts', {
          tabId: 'c',
          groupId: 'g3',
          split: { besideGroupId: 'g1', besideLastGroupId: 'g2', direction: 'up' }
        })
      ],
      model
    )

    expect(opened.model.workspaces[WS]!.groupLayout).toEqual({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', groupId: 'g3' },
      second: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'g1' },
        second: { type: 'leaf', groupId: 'g2' },
        ratio: 0.5
      },
      ratio: 0.5
    })
  })

  it('refuses a split it cannot make, and changes nothing', () => {
    const { ctx, model } = oneGroup()
    const refusal = (command: LayoutCommand) => {
      const applied = applyLayoutCommand(model, command, ctx)
      return applied.ok ? 'applied' : applied.code
    }

    expect(
      refusal(
        editor('/w/b.ts', {
          tabId: 'b',
          groupId: 'g2',
          split: { besideGroupId: 'missing', direction: 'right' }
        })
      )
    ).toBe('group_not_found')
    expect(
      refusal(
        editor('/w/b.ts', {
          tabId: 'b',
          groupId: 'g2',
          split: { besideGroupId: 'g1', besideLastGroupId: 'missing', direction: 'right' }
        })
      )
    ).toBe('group_not_found')
    // The group id another workspace holds.
    const other = build(
      ctx,
      [editor('/w/o.ts', { workspace: 'other', tabId: 'o', groupId: 'g2' })],
      model
    ).model
    expect(
      applyLayoutCommand(other, editor('/w/b.ts', { tabId: 'b', groupId: 'g2', split: right }), ctx)
    ).toEqual({ ok: false, code: 'group_exists' })
    expect(refusal(editor('/w/b.ts', { tabId: 'b', split: right }))).toBe('invalid_params')
    // A tab id another file's tab holds: the open itself refuses it.
    expect(refusal(editor('/w/b.ts', { tabId: 'a', groupId: 'g2', split: right }))).toBe(
      'tab_exists'
    )
  })

  it('makes the new group the only one where main holds no group, as beside an emptied root', () => {
    const ctx = testContext()

    const opened = build(ctx, [
      editor('/w/b.ts', {
        tabId: 'b',
        groupId: 'g2',
        split: { besideGroupId: 'root', direction: 'right' }
      })
    ])

    expect(groupsOf(opened.model)).toEqual([{ id: 'g2', tabOrder: ['b'] }])
    expect(opened.model.workspaces[WS]!.groupLayout).toBeUndefined()
  })

  it('opens into a group main already holds, as an open without a split', () => {
    const { ctx, model } = oneGroup()

    const opened = build(
      ctx,
      [editor('/w/b.ts', { tabId: 'b', groupId: 'g1', split: right })],
      model
    )

    expect(groupsOf(opened.model)).toEqual([{ id: 'g1', tabOrder: ['a', 'p', 'b'] }])
  })

  it('changes nothing for the same open again', () => {
    const { ctx, model } = oneGroup()
    const command = editor('/w/b.ts', { tabId: 'b', groupId: 'g2', split: right })
    const once = build(ctx, [command], model).model

    expect(build(ctx, [command], once).model).toEqual(once)
  })

  it('adds no group when the open places nothing', () => {
    const { ctx, model } = oneGroup()

    const initial = build(
      ctx,
      [
        {
          type: 'createTerminalTab',
          workspace: WS,
          groupId: 'g2',
          split: right,
          initial: 'activation'
        }
      ],
      model
    )

    expect(initial.model).toEqual(model)
  })

  it('survives a save and reload unchanged', () => {
    const { ctx, model } = oneGroup()
    const opened = build(
      ctx,
      [editor('/w/b.ts', { tabId: 'b', groupId: 'g2', split: right })],
      model
    ).model

    let next = 0
    const reloaded = loadWorkspaceLayout(
      LOCAL_EXECUTION_HOST_ID,
      saveWorkspaceLayout(asLoaded(opened)),
      {
        mintId: () => `reload-${++next}`,
        mintLeafId: () => `00000000-0000-4000-9000-${String(++next).padStart(12, '0')}`
      }
    )

    expect(groupsOf(reloaded.layout)).toEqual(groupsOf(opened))
    expect(reloaded.layout.workspaces[WS]!.groupLayout).toEqual(opened.workspaces[WS]!.groupLayout)
  })
})
