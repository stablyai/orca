import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'

const SIDE_QUEST_ACTION_HALF_WIDTH = 88
const SIDE_QUEST_ACTION_VIEWPORT_GAP = 8
const SIDE_QUEST_ACTION_HEIGHT = 28

export type TerminalSideQuestSelection = {
  paneId: number
  leafId: string
  capturedText: string
  sourceLabel: string
  point: { x: number; y: number }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

function resolveActionPoint(clientX: number, clientY: number): { x: number; y: number } {
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const horizontalInset = Math.min(SIDE_QUEST_ACTION_HALF_WIDTH, viewportWidth / 2)
  const pointAboveSelection = clientY - SIDE_QUEST_ACTION_HEIGHT - SIDE_QUEST_ACTION_VIEWPORT_GAP
  const verticalPosition =
    pointAboveSelection >= SIDE_QUEST_ACTION_VIEWPORT_GAP
      ? pointAboveSelection
      : clientY + SIDE_QUEST_ACTION_VIEWPORT_GAP

  return {
    x: clamp(clientX, horizontalInset, Math.max(horizontalInset, viewportWidth - horizontalInset)),
    y: clamp(
      verticalPosition,
      SIDE_QUEST_ACTION_VIEWPORT_GAP,
      Math.max(SIDE_QUEST_ACTION_VIEWPORT_GAP, viewportHeight - SIDE_QUEST_ACTION_HEIGHT)
    )
  }
}

export function captureTerminalSideQuestSelection(args: {
  manager: PaneManager | null
  target: EventTarget | null
  clientX: number
  clientY: number
  sourceLabelForPane: (pane: ManagedPane) => string
}): TerminalSideQuestSelection | null {
  const target = args.target
  if (!args.manager || !(target instanceof Node)) {
    return null
  }

  const pane = args.manager.getPanes().find((candidate) => candidate.container.contains(target))
  const capturedText = pane?.terminal.getSelection().trim() ?? ''
  if (!pane || !capturedText) {
    return null
  }

  return {
    paneId: pane.id,
    leafId: pane.leafId,
    capturedText,
    sourceLabel: args.sourceLabelForPane(pane),
    point: resolveActionPoint(args.clientX, args.clientY)
  }
}
