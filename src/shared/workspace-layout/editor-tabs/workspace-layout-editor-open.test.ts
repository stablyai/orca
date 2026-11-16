import { describe, expect, it } from 'vitest'
import { applyLayoutCommand } from '../workspace-layout-commands'
import type { CommandOf } from '../workspace-layout-command-types'
import { build, testContext, WS } from '../commands/workspace-layout-command.test-fixture'

const open = (
  fileId: string,
  fields: Partial<CommandOf<'openEditorTab'>> = {}
): CommandOf<'openEditorTab'> => ({
  type: 'openEditorTab',
  workspace: WS,
  fileId,
  contentType: 'editor',
  ...fields
})

/** Two groups: A in the first, B split off to the right into the second. */
function twoGroups() {
  const ctx = testContext()
  const first = build(ctx, [open('/w/a.ts'), open('/w/b.ts')])
  const [a, b] = first.results.map((result) => result.tabId!)
  const groupOne = first.model.workspaces[WS]!.groups[0]!.id
  const split = build(
    ctx,
    [{ type: 'splitGroup', workspace: WS, tabId: b!, besideGroupId: groupOne, direction: 'right' }],
    first.model
  )
  const groupTwo = split.model.workspaces[WS]!.groups.find((group) => group.id !== groupOne)!.id
  return { ctx, model: split.model, a: a!, b: b!, groupOne, groupTwo }
}

describe('openEditorTab', () => {
  it("takes the window's tab id; the same open again changes nothing and a held id is refused", () => {
    const { ctx, model, b, groupOne } = twoGroups()

    const drawn = build(ctx, [open('/w/c.ts', { tabId: 'window-tab', groupId: groupOne })], model)
    expect(drawn.results[0]!.tabId).toBe('window-tab')
    expect(
      drawn.model.workspaces[WS]!.groups.find((group) => group.id === groupOne)!.tabOrder
    ).toContain('window-tab')

    const resent = applyLayoutCommand(
      drawn.model,
      open('/w/c.ts', { tabId: 'window-tab', groupId: groupOne }),
      ctx
    )
    expect(resent).toMatchObject({ ok: true, result: { tabId: 'window-tab' } })
    expect(resent.ok && resent.model).toEqual(drawn.model)

    expect(applyLayoutCommand(model, open('/w/c.ts', { tabId: b }), ctx)).toEqual({
      ok: false,
      code: 'tab_exists'
    })
  })

  it('pins a preview tab that a non-preview open finds, and keeps it on a preview open', () => {
    const ctx = testContext()
    const { model, results } = build(ctx, [open('/w/a.ts', { preview: true })])
    const tabId = results[0]!.tabId!

    const previewAgain = build(ctx, [open('/w/a.ts', { preview: true })], model)
    expect(previewAgain.model.workspaces[WS]!.tabs[0]!.isPreview).toBe(true)

    const pinned = build(ctx, [open('/w/a.ts')], model)
    expect(pinned.results[0]!.tabId).toBe(tabId)
    expect(pinned.model.workspaces[WS]!.tabs[0]!.isPreview).toBeUndefined()
  })

  it("replaces only the target group's preview", () => {
    const { ctx, model, groupOne, groupTwo } = twoGroups()
    const previews = build(
      ctx,
      [
        open('/w/p1.ts', { preview: true, groupId: groupOne }),
        open('/w/p2.ts', { preview: true, groupId: groupTwo }),
        open('/w/p3.ts', { preview: true, groupId: groupTwo })
      ],
      model
    )
    const entities = previews.model.workspaces[WS]!.tabs.map((tab) => tab.entityId)
    expect(entities).toEqual(expect.arrayContaining(['/w/p1.ts', '/w/p3.ts']))
    expect(entities).not.toContain('/w/p2.ts')
  })

  it("refuses a group main lacks, but gives a workspace with no group the sender's", () => {
    const { ctx, model } = twoGroups()
    expect(applyLayoutCommand(model, open('/w/c.ts', { groupId: 'window-only' }), ctx)).toEqual({
      ok: false,
      code: 'group_not_found'
    })

    const fresh = build(ctx, [open('/w/c.ts', { tabId: 'window-tab', groupId: 'window-group' })])
    expect(fresh.model.workspaces[WS]!.groups).toEqual([
      { id: 'window-group', tabOrder: ['window-tab'] }
    ])
  })
})
