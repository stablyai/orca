export type SelectionIntent = 'replace' | 'toggle' | 'range'

export type SelectionResult = {
  selectedIds: Set<string>
  anchorId: string
}

export type AreaSelectionResult = {
  selectedIds: Set<string>
  anchorId: string | null
}

export function getSelectionIntent(
  event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>,
  isMac: boolean
): SelectionIntent {
  if (event.shiftKey) {
    return 'range'
  }
  const toggle = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  return toggle ? 'toggle' : 'replace'
}

export function updateSelection(params: {
  visibleIds: readonly string[]
  previousSelectedIds: ReadonlySet<string>
  previousAnchorId: string | null
  targetId: string
  intent: SelectionIntent
  additiveRange?: boolean
}): SelectionResult {
  const { visibleIds, previousSelectedIds, previousAnchorId, targetId, intent, additiveRange } =
    params

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
  const selectedIds = new Set(additiveRange ? previousSelectedIds : undefined)
  if (!anchorId) {
    selectedIds.add(targetId)
    return { selectedIds, anchorId: targetId }
  }
  const targetIndex = visibleIds.indexOf(targetId)
  const anchorIndex = visibleIds.indexOf(anchorId)
  if (targetIndex === -1 || anchorIndex === -1) {
    selectedIds.add(targetId)
    return { selectedIds, anchorId: targetId }
  }

  const start = Math.min(anchorIndex, targetIndex)
  const end = Math.max(anchorIndex, targetIndex)
  for (let index = start; index <= end; index += 1) {
    selectedIds.add(visibleIds[index]!)
  }
  return { selectedIds, anchorId }
}

export function pruneSelection(
  selectedIds: ReadonlySet<string>,
  anchorId: string | null,
  visibleIds: readonly string[] | ReadonlySet<string>,
  hasRetainedId?: (id: string) => boolean,
  canSelectId?: (id: string) => boolean
): { selectedIds: Set<string>; anchorId: string | null } {
  const visible = 'has' in visibleIds ? visibleIds : new Set(visibleIds)
  const next = new Set<string>()
  let firstVisible: string | null = null
  for (const id of selectedIds) {
    if (canSelectId?.(id) === false) {
      continue
    }
    if (visible.has(id)) {
      firstVisible ??= id
      next.add(id)
    } else if (hasRetainedId?.(id)) {
      next.add(id)
    }
  }
  return {
    selectedIds: next,
    anchorId:
      anchorId && visible.has(anchorId) && canSelectId?.(anchorId) !== false
        ? anchorId
        : firstVisible
  }
}

export function updateAreaSelection(params: {
  visibleIds: readonly string[]
  previousSelectedIds: ReadonlySet<string>
  previousAnchorId: string | null
  areaIds: readonly string[]
  additive: boolean
}): AreaSelectionResult {
  const { visibleIds, previousSelectedIds, previousAnchorId, areaIds, additive } = params
  const areaIdSet = new Set(areaIds)
  const orderedAreaIds = visibleIds.filter((id) => areaIdSet.has(id))

  if (additive) {
    const selectedIds = new Set(previousSelectedIds)
    for (const id of orderedAreaIds) {
      selectedIds.add(id)
    }
    return {
      selectedIds,
      anchorId: orderedAreaIds.at(-1) ?? previousAnchorId
    }
  }

  return {
    selectedIds: new Set(orderedAreaIds),
    anchorId: orderedAreaIds.at(-1) ?? null
  }
}

export function areSelectionsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
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
