import type { TabGroupLayoutNode } from '../../../../shared/tab-types'
import type {
  WorkspaceMultiplexerPane,
  WorkspaceMultiplexerSlot,
  WorkspaceMultiplexerState
} from '../../../../shared/workspace-multiplexer-types'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { TabSplitDirection } from '@/store/slices/tabs'
import { buildSplitNode, removeLeaf, replaceLeaf } from '@/store/slices/tabs/tabs-layout'

export function insertWorkspaceMultiplexerSlot(
  multiplexer: WorkspaceMultiplexerState,
  slot: WorkspaceMultiplexerSlot,
  sourceSlotId: string | null,
  direction: TabSplitDirection = 'right'
): WorkspaceMultiplexerState {
  const splitDirection = direction === 'up' || direction === 'down' ? 'vertical' : 'horizontal'
  const pane: WorkspaceMultiplexerPane = {
    id: slot.id,
    activeSlotId: slot.id,
    slotOrder: [slot.id]
  }
  const sourcePaneId = (
    findWorkspaceMultiplexerPaneForSlot(multiplexer, sourceSlotId) ??
    multiplexer.panes.find((candidate) => candidate.id === sourceSlotId)
  )?.id
  if (!multiplexer.layout || !sourcePaneId) {
    return {
      slots: [...multiplexer.slots, slot],
      panes: [...multiplexer.panes, pane],
      layout: multiplexer.layout
        ? {
            type: 'split',
            direction: splitDirection,
            first: multiplexer.layout,
            second: { type: 'leaf', groupId: pane.id },
            ratio: 0.5
          }
        : { type: 'leaf', groupId: pane.id }
    }
  }
  const replacement = buildSplitNode(
    sourcePaneId,
    pane.id,
    splitDirection,
    direction === 'left' || direction === 'up' ? 'first' : 'second'
  )
  const layout = replaceLeaf(multiplexer.layout, sourcePaneId, replacement)
  return {
    slots: [...multiplexer.slots, slot],
    panes: [...multiplexer.panes, pane],
    layout:
      layout === multiplexer.layout
        ? {
            type: 'split',
            direction: splitDirection,
            first: multiplexer.layout,
            second: { type: 'leaf', groupId: pane.id },
            ratio: 0.5
          }
        : layout
  }
}

export function getWorkspaceMultiplexerLayoutPaneIds(layout: TabGroupLayoutNode | null): string[] {
  if (!layout) {
    return []
  }
  return layout.type === 'leaf'
    ? [layout.groupId]
    : [
        ...getWorkspaceMultiplexerLayoutPaneIds(layout.first),
        ...getWorkspaceMultiplexerLayoutPaneIds(layout.second)
      ]
}

export function findWorkspaceMultiplexerPaneForSlot(
  multiplexer: WorkspaceMultiplexerState,
  slotId: string | null
): WorkspaceMultiplexerPane | null {
  return slotId ? (multiplexer.panes.find((pane) => pane.slotOrder.includes(slotId)) ?? null) : null
}

export function activateWorkspaceMultiplexerSlot(
  multiplexer: WorkspaceMultiplexerState,
  paneId: string,
  slotId: string
): WorkspaceMultiplexerState {
  const pane = multiplexer.panes.find((candidate) => candidate.id === paneId)
  if (!pane || pane.activeSlotId === slotId || !pane.slotOrder.includes(slotId)) {
    return multiplexer
  }
  return {
    ...multiplexer,
    panes: multiplexer.panes.map((candidate) =>
      candidate.id === paneId ? { ...candidate, activeSlotId: slotId } : candidate
    )
  }
}

export function removeWorkspaceMultiplexerSlot(
  multiplexer: WorkspaceMultiplexerState,
  slotId: string
): WorkspaceMultiplexerState {
  const pane = findWorkspaceMultiplexerPaneForSlot(multiplexer, slotId)
  if (!pane) {
    return multiplexer
  }
  const removedIndex = pane.slotOrder.indexOf(slotId)
  const slotOrder = pane.slotOrder.filter((candidate) => candidate !== slotId)
  const panes = slotOrder.length
    ? multiplexer.panes.map((candidate) =>
        candidate.id === pane.id
          ? {
              ...candidate,
              slotOrder,
              activeSlotId:
                candidate.activeSlotId === slotId
                  ? slotOrder[Math.min(removedIndex, slotOrder.length - 1)]!
                  : candidate.activeSlotId
            }
          : candidate
      )
    : multiplexer.panes.filter((candidate) => candidate.id !== pane.id)
  return {
    slots: multiplexer.slots.filter((candidate) => candidate.id !== slotId),
    panes,
    layout:
      slotOrder.length || !multiplexer.layout
        ? multiplexer.layout
        : removeLeaf(multiplexer.layout, pane.id)
  }
}

export type WorkspaceMultiplexerSlotDropTarget = {
  paneId: string
  targetSlotId?: string
  insertSide?: 'left' | 'right'
  splitDirection?: TabSplitDirection
}

export function dropWorkspaceMultiplexerSlot(
  multiplexer: WorkspaceMultiplexerState,
  slotId: string,
  target: WorkspaceMultiplexerSlotDropTarget
): WorkspaceMultiplexerState {
  const sourcePane = findWorkspaceMultiplexerPaneForSlot(multiplexer, slotId)
  const targetPane = multiplexer.panes.find((pane) => pane.id === target.paneId)
  if (!sourcePane || !targetPane || target.targetSlotId === slotId) {
    return multiplexer
  }
  if (target.splitDirection) {
    return splitWorkspaceMultiplexerSlot(
      multiplexer,
      slotId,
      sourcePane,
      targetPane,
      target.splitDirection
    )
  }
  if (sourcePane.id === targetPane.id && !target.targetSlotId) {
    return multiplexer
  }

  const targetOrder = targetPane.slotOrder.filter((candidate) => candidate !== slotId)
  const targetIndex = target.targetSlotId
    ? targetOrder.indexOf(target.targetSlotId)
    : targetOrder.length
  const insertIndex =
    targetIndex < 0 ? targetOrder.length : targetIndex + (target.insertSide === 'right' ? 1 : 0)
  targetOrder.splice(insertIndex, 0, slotId)
  if (sourcePane.id === targetPane.id) {
    const unchanged = sourcePane.slotOrder.every(
      (candidate, index) => candidate === targetOrder[index]
    )
    return unchanged && sourcePane.activeSlotId === slotId
      ? multiplexer
      : {
          ...multiplexer,
          panes: multiplexer.panes.map((pane) =>
            pane.id === sourcePane.id
              ? { ...pane, activeSlotId: slotId, slotOrder: targetOrder }
              : pane
          )
        }
  }

  const sourceOrder = sourcePane.slotOrder.filter((candidate) => candidate !== slotId)
  const sourceRemoved = sourceOrder.length === 0
  return {
    ...multiplexer,
    panes: multiplexer.panes.flatMap((pane) => {
      if (pane.id === sourcePane.id) {
        return sourceRemoved
          ? []
          : [
              {
                ...pane,
                slotOrder: sourceOrder,
                activeSlotId: pane.activeSlotId === slotId ? sourceOrder[0]! : pane.activeSlotId
              }
            ]
      }
      return pane.id === targetPane.id
        ? [{ ...pane, activeSlotId: slotId, slotOrder: targetOrder }]
        : [pane]
    }),
    layout:
      sourceRemoved && multiplexer.layout
        ? removeLeaf(multiplexer.layout, sourcePane.id)
        : multiplexer.layout
  }
}

function splitWorkspaceMultiplexerSlot(
  multiplexer: WorkspaceMultiplexerState,
  slotId: string,
  sourcePane: WorkspaceMultiplexerPane,
  targetPane: WorkspaceMultiplexerPane,
  direction: TabSplitDirection
): WorkspaceMultiplexerState {
  if (
    !multiplexer.layout ||
    (sourcePane.id === targetPane.id && sourcePane.slotOrder.length === 1)
  ) {
    return multiplexer
  }
  const sourceOrder = sourcePane.slotOrder.filter((candidate) => candidate !== slotId)
  const sourceRemoved = sourceOrder.length === 0
  const panes = multiplexer.panes.flatMap((pane) => {
    if (pane.id !== sourcePane.id) {
      return [pane]
    }
    return sourceRemoved
      ? []
      : [
          {
            ...pane,
            slotOrder: sourceOrder,
            activeSlotId: pane.activeSlotId === slotId ? sourceOrder[0]! : pane.activeSlotId
          }
        ]
  })
  const newPane: WorkspaceMultiplexerPane = {
    id: createBrowserUuid(),
    activeSlotId: slotId,
    slotOrder: [slotId]
  }
  const baseLayout = sourceRemoved
    ? removeLeaf(multiplexer.layout, sourcePane.id)
    : multiplexer.layout
  if (!baseLayout) {
    return multiplexer
  }
  const horizontal = direction === 'left' || direction === 'right'
  const replacement = buildSplitNode(
    targetPane.id,
    newPane.id,
    horizontal ? 'horizontal' : 'vertical',
    direction === 'left' || direction === 'up' ? 'first' : 'second'
  )
  return {
    ...multiplexer,
    panes: [...panes, newPane],
    layout: replaceLeaf(baseLayout, targetPane.id, replacement)
  }
}

export function moveWorkspaceMultiplexerSlot(
  multiplexer: WorkspaceMultiplexerState,
  slotId: string,
  offset: -1 | 1
): WorkspaceMultiplexerState {
  const pane = findWorkspaceMultiplexerPaneForSlot(multiplexer, slotId)
  if (!pane) {
    return multiplexer
  }
  const targetSlotId = pane.slotOrder[pane.slotOrder.indexOf(slotId) + offset]
  return targetSlotId
    ? dropWorkspaceMultiplexerSlot(multiplexer, slotId, {
        paneId: pane.id,
        targetSlotId,
        insertSide: offset < 0 ? 'left' : 'right'
      })
    : multiplexer
}
