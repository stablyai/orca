import {
  normalizeWorkspaceMultiplexerState,
  type WorkspaceMultiplexerState
} from './workspace-multiplexer-types'
import { removeLeaf } from './tab-layout-remove-leaf'

export function removeWorkspaceMultiplexerSlot(
  multiplexer: WorkspaceMultiplexerState,
  slotId: string
): WorkspaceMultiplexerState {
  const pane = multiplexer.panes.find((candidate) => candidate.slotOrder.includes(slotId))
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
  return normalizeWorkspaceMultiplexerState({
    ...multiplexer,
    slots: multiplexer.slots.filter((candidate) => candidate.id !== slotId),
    panes,
    layout:
      slotOrder.length || !multiplexer.layout
        ? multiplexer.layout
        : removeLeaf(multiplexer.layout, pane.id)
  })
}
