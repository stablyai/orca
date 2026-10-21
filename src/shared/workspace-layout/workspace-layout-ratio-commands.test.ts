// Divider ratios through main: a window's ratio intents apply to main's own tree, and an older
// window's whole tree is taken only where its panes or groups match main's.

import { describe, expect, it } from 'vitest'
import { applyLayoutCommand } from './workspace-layout-commands'
import type { LayoutCommand } from './workspace-layout-command-types'
import { build, terminalTab, testContext, WS } from './workspace-layout-command.test-fixture'
import type { WorkspaceLayoutModel } from './workspace-layout-model'

const context = testContext()

/** Two terminal tabs, the first split in two, in one group. */
function setup() {
  const ctx = testContext()
  const { model, results } = build(ctx, [
    { type: 'createTerminalTab', workspace: WS },
    { type: 'createTerminalTab', workspace: WS }
  ])
  const [first, second] = results
  const split = build(
    ctx,
    [
      {
        type: 'splitPane',
        workspace: WS,
        tabId: first!.tabId!,
        leafId: first!.leafId!,
        direction: 'vertical'
      }
    ],
    model
  )
  return {
    ctx,
    model: split.model,
    tabA: first!.tabId!,
    leafA: first!.leafId!,
    leafA2: split.results[0]!.leafId!,
    tabB: second!.tabId!
  }
}

function refusal(model: WorkspaceLayoutModel, command: LayoutCommand) {
  const result = applyLayoutCommand(model, command, context)
  return result.ok ? 'applied' : result.code
}

describe('divider ratios through main', () => {
  it('setPaneRatios accepts divider sizes only', () => {
    const { model, tabA, leafA, leafA2 } = setup()
    const root = terminalTab(model, tabA).panes!.root!
    if (root.type !== 'split') {
      throw new Error('expected a split')
    }
    expect(
      refusal(model, {
        type: 'setPaneRatios',
        workspace: WS,
        tabId: tabA,
        root: { ...root, ratio: 0.3 }
      })
    ).toBe('applied')
    const swapped = {
      type: 'split' as const,
      direction: 'vertical' as const,
      first: { type: 'leaf' as const, leafId: leafA2 },
      second: { type: 'leaf' as const, leafId: leafA }
    }
    expect(
      refusal(model, { type: 'setPaneRatios', workspace: WS, tabId: tabA, root: swapped })
    ).toBe('pane_structure_changed')
    expect(
      refusal(model, {
        type: 'setPaneRatios',
        workspace: WS,
        tabId: tabA,
        root: { type: 'leaf', leafId: leafA }
      })
    ).toBe('pane_structure_changed')
  })

  it('setPaneRatios applies divider intents to main’s own tree, and refuses a path with no split', () => {
    const { model, tabA } = setup()
    const applied = applyLayoutCommand(
      model,
      { type: 'setPaneRatios', workspace: WS, tabId: tabA, ratios: [{ path: '', ratio: 0.3 }] },
      context
    )
    expect(applied.ok && terminalTab(applied.model, tabA).panes!.root).toMatchObject({
      type: 'split',
      ratio: 0.3
    })
    // Back to even is saved as no ratio, as the window saves it.
    const even = applied.ok
      ? applyLayoutCommand(
          applied.model,
          { type: 'setPaneRatios', workspace: WS, tabId: tabA, ratios: [{ path: '', ratio: 0.5 }] },
          context
        )
      : applied
    expect(even.ok && terminalTab(even.model, tabA).panes!.root).not.toHaveProperty('ratio')
    expect(
      refusal(model, {
        type: 'setPaneRatios',
        workspace: WS,
        tabId: tabA,
        ratios: [{ path: 'first', ratio: 0.3 }]
      })
    ).toBe('pane_structure_changed')
  })

  it('setGroupRatios applies divider intents to main’s own groups, and refuses a path with no split', () => {
    const { model, tabB } = setup()
    const groupId = model.workspaces[WS]!.groups[0]!.id
    const split = applyLayoutCommand(
      model,
      {
        type: 'splitGroup',
        workspace: WS,
        tabId: tabB,
        besideGroupId: groupId,
        direction: 'right'
      },
      context
    )
    if (!split.ok) {
      throw new Error('expected a group split')
    }
    const applied = applyLayoutCommand(
      split.model,
      { type: 'setGroupRatios', workspace: WS, ratios: [{ path: '', ratio: 0.7 }] },
      context
    )
    expect(applied.ok && applied.model.workspaces[WS]!.groupLayout).toMatchObject({
      type: 'split',
      ratio: 0.7
    })
    expect(
      refusal(split.model, {
        type: 'setGroupRatios',
        workspace: WS,
        ratios: [{ path: 'second', ratio: 0.7 }]
      })
    ).toBe('group_set_changed')
    expect(
      refusal(model, { type: 'setGroupRatios', workspace: WS, ratios: [{ path: '', ratio: 0.7 }] })
    ).toBe('group_set_changed')
  })

  it('applies an intent only to the split it means: a path now naming another split moves nothing', () => {
    const { model, tabA, leafA, leafA2 } = setup()
    const before = terminalTab(model, tabA).panes!.root
    const meant = { direction: 'vertical', first: leafA, second: leafA2 }
    expect(
      refusal(model, {
        type: 'setPaneRatios',
        workspace: WS,
        tabId: tabA,
        ratios: [{ path: '', ratio: 0.3, split: meant }]
      })
    ).toBe('applied')
    // Main's panes moved on: the root split is now another one.
    for (const split of [
      { ...meant, first: leafA2, second: leafA },
      { ...meant, direction: 'horizontal' }
    ]) {
      const refused = applyLayoutCommand(
        model,
        {
          type: 'setPaneRatios',
          workspace: WS,
          tabId: tabA,
          ratios: [{ path: '', ratio: 0.3, split }]
        },
        context
      )
      expect(refused.ok ? 'applied' : refused.code).toBe('pane_structure_changed')
      expect(terminalTab(model, tabA).panes!.root).toEqual(before)
    }
  })

  it('applies a group intent only to the split it means', () => {
    const { ctx, model, tabB } = setup()
    const groupId = model.workspaces[WS]!.groups[0]!.id
    // The model's own id minter, so the new group's id is not one the model already holds.
    const split = applyLayoutCommand(
      model,
      {
        type: 'splitGroup',
        workspace: WS,
        tabId: tabB,
        besideGroupId: groupId,
        direction: 'right'
      },
      ctx
    )
    if (!split.ok || split.model.workspaces[WS]!.groupLayout?.type !== 'split') {
      throw new Error('expected a group split')
    }
    const layout = split.model.workspaces[WS]!.groupLayout
    if (layout.type !== 'split' || layout.first.type !== 'leaf' || layout.second.type !== 'leaf') {
      throw new Error('expected two groups side by side')
    }
    const meant = {
      direction: layout.direction,
      first: layout.first.groupId,
      second: layout.second.groupId
    }
    expect(
      refusal(split.model, {
        type: 'setGroupRatios',
        workspace: WS,
        ratios: [{ path: '', ratio: 0.7, split: meant }]
      })
    ).toBe('applied')
    expect(
      refusal(split.model, {
        type: 'setGroupRatios',
        workspace: WS,
        ratios: [
          { path: '', ratio: 0.7, split: { ...meant, first: meant.second, second: meant.first } }
        ]
      })
    ).toBe('group_set_changed')
  })
})
