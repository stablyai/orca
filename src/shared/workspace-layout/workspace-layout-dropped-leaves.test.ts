// The dropped-leaf step (L80 Q2): which panes a live edit dropped, and what it records for them.
import { describe, expect, it, vi } from 'vitest'
import { applyLayoutCommand } from './workspace-layout-commands'
import {
  build,
  emptyModel,
  testContext,
  terminalTab,
  WS
} from './workspace-layout-command.test-fixture'
import type { LayoutCommand, LayoutContext } from './workspace-layout-command-types'
import { droppedLeavesOf } from './workspace-layout-dropped-leaves'
import type { WorkspaceLayoutModel } from './workspace-layout-model'
import { collectLayoutLeafIdsInOrder } from './terminal-pane-tree'

vi.mock('../layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const OTHER_WS = 'repo-1::/Users/dev/other'

/** A create's result: the tab and leaf it made. */
function createdPane(value: unknown): { tabId: string; leafId: string } {
  if (
    !value ||
    typeof value !== 'object' ||
    !('tabId' in value) ||
    !('leafId' in value) ||
    typeof value.tabId !== 'string' ||
    typeof value.leafId !== 'string'
  ) {
    throw new Error('expected a created terminal pane')
  }
  return { tabId: value.tabId, leafId: value.leafId }
}

/** Two terminal tabs, the first split; every pane bound to its own terminal incarnation. */
function boundLayout(context: LayoutContext) {
  const { model, results } = build(context, [
    { type: 'createTerminalTab', workspace: WS },
    { type: 'createTerminalTab', workspace: WS }
  ])
  const [first, second] = results.map(createdPane)
  const split = build(
    context,
    [
      {
        type: 'splitPane',
        workspace: WS,
        tabId: first!.tabId,
        leafId: first!.leafId,
        direction: 'vertical'
      }
    ],
    model
  ).model
  const workspace = split.workspaces[WS]!
  const leaves = { ...workspace.leaves }
  for (const tab of workspace.tabs) {
    for (const leafId of tab.kind === 'terminal'
      ? collectLayoutLeafIdsInOrder(tab.panes.root)
      : []) {
      leaves[leafId] = { ...leaves[leafId], ptyId: `pty-${leafId}`, incarnationId: `inc-${leafId}` }
    }
  }
  const bound: WorkspaceLayoutModel = {
    ...split,
    workspaces: { ...split.workspaces, [WS]: { ...workspace, leaves } }
  }
  const [leafA, leafB] = collectLayoutLeafIdsInOrder(terminalTab(bound, first!.tabId).panes.root)
  return {
    model: bound,
    tabA: first!.tabId,
    leafA: leafA!,
    leafB: leafB!,
    tabB: second!.tabId,
    leafC: second!.leafId
  }
}

const LIVE: Partial<LayoutContext> = { droppedLeafReason: 'live-edit' }

function apply(model: WorkspaceLayoutModel, command: LayoutCommand, context: LayoutContext) {
  const applied = applyLayoutCommand(model, command, context)
  if (!applied.ok) {
    throw new Error(`${command.type} refused: ${applied.code}`)
  }
  return applied.model
}

function recorded(model: WorkspaceLayoutModel) {
  return model.records.closedTerminalPanesByPaneKey ?? {}
}

describe('the dropped-leaf step', () => {
  it('records a closed pane’s terminal, with the partition that runs it', () => {
    const context = { ...testContext(), ...LIVE }
    const { model, tabA, leafB } = boundLayout(context)

    const closed = apply(
      model,
      { type: 'closePane', workspace: WS, tabId: tabA, leafId: leafB },
      context
    )

    expect(droppedLeavesOf(model, closed)).toEqual([
      {
        hostId: model.hostId,
        worktreeId: WS,
        tabId: tabA,
        leafId: leafB,
        ptyId: `pty-${leafB}`,
        incarnationId: `inc-${leafB}`
      }
    ])
    expect(Object.keys(recorded(closed))).toEqual([`${tabA}:${leafB}`])
  })

  it('records every pane of a closed tab', () => {
    const context = { ...testContext(), ...LIVE }
    const { model, tabA, leafA, leafB } = boundLayout(context)

    const closed = apply(
      model,
      { type: 'closeTabs', workspace: WS, tabIds: [tabA], force: true },
      context
    )

    expect(Object.keys(recorded(closed)).sort()).toEqual(
      [`${tabA}:${leafA}`, `${tabA}:${leafB}`].sort()
    )
  })

  it('does not take a pane moved to another tab for a dropped one', () => {
    const context = { ...testContext(), ...LIVE }
    const { model, tabA, leafB } = boundLayout(context)

    const moved = apply(
      model,
      { type: 'movePaneToNewTab', workspace: WS, tabId: tabA, leafId: leafB },
      context
    )

    expect(droppedLeavesOf(model, moved)).toEqual([])
    expect(recorded(moved)).toEqual({})
  })

  it('does not take a pane split-dragged within its tab for a dropped one', () => {
    const context = { ...testContext(), ...LIVE }
    const { model, tabA, leafA, leafB } = boundLayout(context)

    const dragged = apply(
      model,
      {
        type: 'movePane',
        workspace: WS,
        tabId: tabA,
        leafId: leafB,
        targetLeafId: leafA,
        side: 'top'
      },
      context
    )

    expect(droppedLeavesOf(model, dragged)).toEqual([])
    expect(recorded(dragged)).toEqual({})
  })

  it('does not take a pane that moved to another workspace in the same commit for a dropped one', () => {
    const { model, tabA, leafB } = boundLayout(testContext())
    const source = model.workspaces[WS]!
    const tab = terminalTab(model, tabA)
    // The whole tab leaves WS and arrives in OTHER_WS, its panes and terminals with it.
    const after: WorkspaceLayoutModel = {
      ...model,
      workspaces: {
        [WS]: { ...source, tabs: source.tabs.filter((entry) => entry.id !== tabA) },
        [OTHER_WS]: { ...source, worktreeId: OTHER_WS, tabs: [tab] }
      }
    }

    expect(droppedLeavesOf(model, after).map((leaf) => leaf.leafId)).not.toContain(leafB)
    expect(droppedLeavesOf(model, after)).toEqual([])
  })

  it('records nothing for a commit that is not a live edit', () => {
    const context = testContext()
    const { model, tabA } = boundLayout(context)

    const closed = apply(
      model,
      { type: 'closeTabs', workspace: WS, tabIds: [tabA], force: true },
      context
    )

    expect(recorded(closed)).toEqual({})
  })

  it('records a drop once though the commit runs again', () => {
    const context = { ...testContext(), ...LIVE }
    const { model, tabA, leafB } = boundLayout(context)
    const close: LayoutCommand = { type: 'closePane', workspace: WS, tabId: tabA, leafId: leafB }

    const once = apply(model, close, context)
    // A retry against the same base, as a replayed write would run it.
    const replayed = applyLayoutCommand({ ...model, records: once.records }, close, context)

    expect(replayed.ok && recorded(replayed.model)).toEqual(recorded(once))
  })

  it('records nothing in a window-owned commit with no workspaces changed', () => {
    const model = emptyModel()
    expect(droppedLeavesOf(model, model)).toEqual([])
  })
})
