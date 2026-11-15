import { describe, expect, it } from 'vitest'
import '../../execution-host'
import '../tab-groups/tab-group-layout-tree'
import { applyLayoutCommand } from '../workspace-layout-commands'
import type { CommandOf, LayoutCommand, NewGroupSplit } from '../workspace-layout-command-types'
import { build, testContext, WS } from './workspace-layout-command.test-fixture'
import '../persistence/workspace-layout-load'
import '../persistence/workspace-layout-save'

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
    const other = build(
      ctx,
      [editor('/w/o.ts', { workspace: 'other', tabId: 'o', groupId: 'g2' })],
      model
    ).model
    expect(
      applyLayoutCommand(other, editor('/w/b.ts', { tabId: 'b', groupId: 'g2', split: right }), ctx)
    ).toEqual({ ok: false, code: 'group_exists' })
    expect(refusal(editor('/w/b.ts', { tabId: 'b', split: right }))).toBe('invalid_params')
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
})
