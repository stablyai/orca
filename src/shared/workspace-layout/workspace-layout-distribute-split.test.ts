// A distributed split evens out the new group's row; the default split halves only its target.

import { describe, expect, it } from 'vitest'
import type { TabGroupLayoutNode } from '../tab-types'
import { distributeGroupSplitRun } from './tab-group-layout-tree'
import { build, testContext, WS } from './workspace-layout-command.test-fixture'

function threeTabsInOneGroup() {
  const ctx = testContext()
  const { model, results } = build(ctx, [
    { type: 'createTerminalTab', workspace: WS },
    { type: 'createTerminalTab', workspace: WS },
    { type: 'createTerminalTab', workspace: WS }
  ])
  return { ctx, model, tabIds: results.map((result) => result.tabId!) }
}

function splitTwiceRight(distribute: true | undefined): TabGroupLayoutNode {
  const { ctx, model, tabIds } = threeTabsInOneGroup()
  const firstGroupId = model.workspaces[WS]!.groups[0]!.id
  const once = build(
    ctx,
    [
      {
        type: 'splitGroup',
        workspace: WS,
        tabId: tabIds[1]!,
        besideGroupId: firstGroupId,
        direction: 'right'
      }
    ],
    model
  )
  const twice = build(
    ctx,
    [
      {
        type: 'splitGroup',
        workspace: WS,
        tabId: tabIds[2]!,
        besideGroupId: once.results[0]!.groupId!,
        direction: 'right',
        distribute
      }
    ],
    once.model
  )
  return twice.model.workspaces[WS]!.groupLayout!
}

function widths(node: TabGroupLayoutNode, share = 1): number[] {
  if (node.type === 'leaf') {
    return [share]
  }
  const ratio = node.ratio ?? 0.5
  return [...widths(node.first, share * ratio), ...widths(node.second, share * (1 - ratio))]
}

describe('splitGroup sizing', () => {
  it('halves the target group by default', () => {
    expect(widths(splitTwiceRight(undefined))).toEqual([0.5, 0.25, 0.25])
  })

  it('gives every group in the row an equal share when distributing', () => {
    for (const width of widths(splitTwiceRight(true))) {
      expect(width).toBeCloseTo(1 / 3)
    }
  })

  it('keeps the ratios of splits across the row', () => {
    const column: TabGroupLayoutNode = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.7,
      first: { type: 'leaf', groupId: 'top' },
      second: { type: 'leaf', groupId: 'bottom' }
    }
    const layout: TabGroupLayoutNode = {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.8,
      first: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', groupId: 'left' },
        second: { type: 'leaf', groupId: 'new' }
      },
      second: column
    }
    const distributed = distributeGroupSplitRun(layout, 'new')
    expect(widths(distributed).slice(0, 2)).toEqual([1 / 3, 1 / 3])
    expect(distributed.type === 'split' && distributed.second).toBe(column)
  })
})
