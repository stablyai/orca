import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import type { TabGroupLayoutNode } from './tab-types'

export type WorkspaceMultiplexerSlot = {
  id: string
  worktreeId: string
  executionHostId?: ExecutionHostId
  groupId: string | null
  activeTerminalTabId: string | null
}

export type WorkspaceMultiplexerPane = {
  id: string
  activeSlotId: string
  slotOrder: string[]
}

export type WorkspaceMultiplexerState = {
  slots: WorkspaceMultiplexerSlot[]
  panes: WorkspaceMultiplexerPane[]
  /** TabGroupLayoutNode leaves store Multiplexer pane ids, not terminal tab-group ids. */
  layout: TabGroupLayoutNode | null
}

export const EMPTY_WORKSPACE_MULTIPLEXER_STATE: WorkspaceMultiplexerState = {
  slots: [],
  panes: [],
  layout: null
}

export function remapWorkspaceMultiplexerWorktreeId(
  state: WorkspaceMultiplexerState | undefined,
  oldWorktreeId: string,
  newWorktreeId: string,
  executionHostId?: ExecutionHostId
): WorkspaceMultiplexerState | undefined {
  if (!state || oldWorktreeId === newWorktreeId) {
    return state
  }
  let changed = false
  const slots = state.slots.map((slot) => {
    const matchesHost =
      executionHostId === undefined ||
      (slot.executionHostId ?? LOCAL_EXECUTION_HOST_ID) === executionHostId
    if (slot.worktreeId !== oldWorktreeId || !matchesHost) {
      return slot
    }
    changed = true
    return { ...slot, worktreeId: newWorktreeId }
  })
  return changed ? { ...state, slots } : state
}

const MAX_MULTIPLEXER_SLOTS = 24
const MAX_ID_LENGTH = 2_048

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
    ? value
    : null
}

function normalizeLayout(
  value: unknown,
  validSlotIds: ReadonlySet<string>,
  usedSlotIds: Set<string>,
  depth = 0
): TabGroupLayoutNode | null {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    depth > MAX_MULTIPLEXER_SLOTS
  ) {
    return null
  }
  const input = value as Record<string, unknown>
  if (input.type === 'leaf') {
    const slotId = nonEmptyString(input.groupId)
    if (!slotId || !validSlotIds.has(slotId) || usedSlotIds.has(slotId)) {
      return null
    }
    usedSlotIds.add(slotId)
    return { type: 'leaf', groupId: slotId }
  }
  if (
    input.type !== 'split' ||
    (input.direction !== 'horizontal' && input.direction !== 'vertical')
  ) {
    return null
  }
  const first = normalizeLayout(input.first, validSlotIds, usedSlotIds, depth + 1)
  // Why: bail before the sibling so a malformed tree costs one failing path, not 2^depth visits.
  if (!first) {
    return null
  }
  const second = normalizeLayout(input.second, validSlotIds, usedSlotIds, depth + 1)
  if (!second) {
    return null
  }
  const ratio =
    typeof input.ratio === 'number' && Number.isFinite(input.ratio)
      ? Math.min(0.85, Math.max(0.15, input.ratio))
      : 0.5
  return { type: 'split', direction: input.direction, first, second, ratio }
}

export function normalizeWorkspaceMultiplexerState(value: unknown): WorkspaceMultiplexerState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return EMPTY_WORKSPACE_MULTIPLEXER_STATE
  }
  const rawSlots = (value as Record<string, unknown>).slots
  if (!Array.isArray(rawSlots)) {
    return EMPTY_WORKSPACE_MULTIPLEXER_STATE
  }

  const slots: WorkspaceMultiplexerSlot[] = []
  const slotIds = new Set<string>()
  for (const raw of rawSlots.slice(0, MAX_MULTIPLEXER_SLOTS)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      continue
    }
    const input = raw as Record<string, unknown>
    const id = nonEmptyString(input.id)
    const worktreeId = nonEmptyString(input.worktreeId)
    if (!id || !worktreeId || slotIds.has(id)) {
      continue
    }
    slotIds.add(id)
    const parsedHost =
      typeof input.executionHostId === 'string'
        ? parseExecutionHostId(input.executionHostId)?.id
        : undefined
    slots.push({
      id,
      worktreeId,
      ...(parsedHost ? { executionHostId: parsedHost } : {}),
      groupId: input.groupId === null ? null : nonEmptyString(input.groupId),
      activeTerminalTabId:
        input.activeTerminalTabId === null ? null : nonEmptyString(input.activeTerminalTabId)
    })
  }
  if (slots.length === 0) {
    return EMPTY_WORKSPACE_MULTIPLEXER_STATE
  }

  const validSlotIds = new Set(slots.map((slot) => slot.id))
  const panes: WorkspaceMultiplexerPane[] = []
  const paneIds = new Set<string>()
  const assignedSlotIds = new Set<string>()
  const rawPanes = (value as Record<string, unknown>).panes
  if (Array.isArray(rawPanes)) {
    for (const raw of rawPanes.slice(0, MAX_MULTIPLEXER_SLOTS)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        continue
      }
      const input = raw as Record<string, unknown>
      const id = nonEmptyString(input.id)
      if (!id || paneIds.has(id) || !Array.isArray(input.slotOrder)) {
        continue
      }
      const slotOrder = [
        ...new Set(
          input.slotOrder
            .slice(0, MAX_MULTIPLEXER_SLOTS)
            .map(nonEmptyString)
            .filter((slotId): slotId is string => slotId !== null)
        )
      ].filter((slotId) => validSlotIds.has(slotId) && !assignedSlotIds.has(slotId))
      if (slotOrder.length === 0) {
        continue
      }
      for (const slotId of slotOrder) {
        assignedSlotIds.add(slotId)
      }
      const requestedActiveSlotId = nonEmptyString(input.activeSlotId)
      panes.push({
        id,
        activeSlotId:
          requestedActiveSlotId && slotOrder.includes(requestedActiveSlotId)
            ? requestedActiveSlotId
            : slotOrder[0]!,
        slotOrder
      })
      paneIds.add(id)
    }
  }
  for (const slot of slots) {
    if (assignedSlotIds.has(slot.id)) {
      continue
    }
    let paneId = slot.id
    for (let suffix = 1; paneIds.has(paneId); suffix += 1) {
      paneId = `multiplexer-pane-${suffix}`
    }
    panes.push({ id: paneId, activeSlotId: slot.id, slotOrder: [slot.id] })
    paneIds.add(paneId)
  }

  const usedPaneIds = new Set<string>()
  let layout = normalizeLayout((value as Record<string, unknown>).layout, paneIds, usedPaneIds)
  if (!layout) {
    usedPaneIds.clear()
  }
  for (const pane of panes) {
    if (usedPaneIds.has(pane.id)) {
      continue
    }
    layout = layout
      ? {
          type: 'split',
          direction: 'horizontal',
          first: layout,
          second: { type: 'leaf', groupId: pane.id },
          ratio: 0.5
        }
      : { type: 'leaf', groupId: pane.id }
  }
  return { slots, panes, layout }
}
