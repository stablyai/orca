export type WorktreeSelectionIntent = 'replace' | 'toggle' | 'range'

export type WorktreeSelectionResult = {
  selectedIds: Set<string>
  anchorId: string
}

export function getWorktreeSelectionIntent(
  event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>,
  isMac: boolean
): WorktreeSelectionIntent {
  if (event.shiftKey) {
    return 'range'
  }
  const toggle = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  return toggle ? 'toggle' : 'replace'
}

export function updateWorktreeSelection(params: {
  visibleIds: readonly string[]
  previousSelectedIds: ReadonlySet<string>
  previousAnchorId: string | null
  targetId: string
  intent: WorktreeSelectionIntent
}): WorktreeSelectionResult {
  const { visibleIds, previousSelectedIds, previousAnchorId, targetId, intent } = params

  if (intent === 'replace') {
    return { selectedIds: new Set([targetId]), anchorId: targetId }
  }

  if (intent === 'toggle') {
    const next = new Set(previousSelectedIds)
    if (next.has(targetId)) {
      next.delete(targetId)
    } else {
      next.add(targetId)
    }
    return { selectedIds: next, anchorId: targetId }
  }

  const anchorId = previousAnchorId
  if (!anchorId) {
    return { selectedIds: new Set([targetId]), anchorId: targetId }
  }
  const targetIndex = visibleIds.indexOf(targetId)
  const anchorIndex = visibleIds.indexOf(anchorId)
  if (targetIndex === -1 || anchorIndex === -1) {
    return { selectedIds: new Set([targetId]), anchorId: targetId }
  }

  const start = Math.min(anchorIndex, targetIndex)
  const end = Math.max(anchorIndex, targetIndex)
  return {
    selectedIds: new Set(visibleIds.slice(start, end + 1)),
    anchorId
  }
}

export function pruneWorktreeSelection(
  selectedIds: ReadonlySet<string>,
  anchorId: string | null,
  visibleIds: readonly string[]
): { selectedIds: Set<string>; anchorId: string | null } {
  const visible = new Set(visibleIds)
  const next = new Set<string>()
  for (const id of selectedIds) {
    if (visible.has(id)) {
      next.add(id)
    }
  }
  return {
    selectedIds: next,
    anchorId: anchorId && visible.has(anchorId) ? anchorId : (next.values().next().value ?? null)
  }
}

export function areWorktreeSelectionsEqual(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>
): boolean {
  if (a.size !== b.size) {
    return false
  }
  for (const id of a) {
    if (!b.has(id)) {
      return false
    }
  }
  return true
}
