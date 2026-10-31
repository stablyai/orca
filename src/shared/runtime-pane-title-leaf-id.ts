import { FIRST_PANE_ID } from './pane-key'
import { isTerminalLeafId } from './stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalPaneLayoutNode } from './terminal-tab-types'

export type RuntimePaneTitleLeafResolution = {
  title: string | null
  hasAnyPaneTitle: boolean
}

function getLeftmostLeafId(node: TerminalPaneLayoutNode): string {
  return node.type === 'leaf' ? node.leafId : getLeftmostLeafId(node.first)
}

function collectReplayCreatedPaneLeafIds(
  node: TerminalPaneLayoutNode,
  leafIdsInReplayCreationOrder: string[]
): void {
  if (node.type === 'leaf') {
    return
  }

  leafIdsInReplayCreationOrder.push(getLeftmostLeafId(node.second))

  if (node.first.type === 'split') {
    collectReplayCreatedPaneLeafIds(node.first, leafIdsInReplayCreationOrder)
  }
  if (node.second.type === 'split') {
    collectReplayCreatedPaneLeafIds(node.second, leafIdsInReplayCreationOrder)
  }
}

function collectLeafIdsInReplayCreationOrder(
  node: TerminalPaneLayoutNode | null | undefined
): string[] {
  if (!node) {
    return []
  }
  const leafIdsInReplayCreationOrder = [getLeftmostLeafId(node)]
  if (node.type === 'split') {
    collectReplayCreatedPaneLeafIds(node, leafIdsInReplayCreationOrder)
  }
  return leafIdsInReplayCreationOrder
}

export function collectRuntimePaneLeafIds(
  node: TerminalPaneLayoutNode | null | undefined
): string[] {
  if (!node) {
    return []
  }
  if (node.type === 'leaf') {
    return [node.leafId]
  }
  return [...collectRuntimePaneLeafIds(node.first), ...collectRuntimePaneLeafIds(node.second)]
}

export function resolveRuntimePaneTitleLeafId(
  tabLayout: { root?: TerminalLayoutSnapshot['root'] } | undefined,
  runtimePaneId: string
): string | null {
  return resolveRuntimePaneTitleLeafIdFromRoot(tabLayout?.root, runtimePaneId)
}

/** Resolve runtime pane IDs by replay order before assigning sparse titles; a lone background title may belong to another leaf. */
export function resolveRuntimePaneTitleForLeaf(
  tabLayout: { root?: TerminalLayoutSnapshot['root'] } | undefined,
  paneTitles: Record<number, string> | undefined,
  leafId: string
): string | null {
  return resolveRuntimePaneTitleLeafResolution(tabLayout, paneTitles, leafId).title
}

export function resolveRuntimePaneTitleLeafResolution(
  tabLayout: { root?: TerminalLayoutSnapshot['root'] } | undefined,
  paneTitles: Record<number, string> | undefined,
  leafId: string
): RuntimePaneTitleLeafResolution {
  if (!paneTitles) {
    return { title: null, hasAnyPaneTitle: false }
  }

  const titlesByPaneId = paneTitles as Record<string, string>
  let firstTitle: string | null = null
  let hasOnePaneTitle = false
  let hasMultiplePaneTitles = false

  for (const runtimePaneId in titlesByPaneId) {
    if (!Object.hasOwn(titlesByPaneId, runtimePaneId)) {
      continue
    }

    const title = titlesByPaneId[runtimePaneId]
    if (hasOnePaneTitle) {
      hasMultiplePaneTitles = true
    } else {
      firstTitle = title
      hasOnePaneTitle = true
    }

    if (resolveRuntimePaneTitleLeafId(tabLayout, runtimePaneId) === leafId) {
      return { title, hasAnyPaneTitle: true }
    }
  }

  // Without layout, attribute only a lone title; any pane title suppresses stale tab-title fallback.
  if (!tabLayout?.root && hasOnePaneTitle && !hasMultiplePaneTitles) {
    return { title: firstTitle, hasAnyPaneTitle: true }
  }

  return { title: null, hasAnyPaneTitle: hasOnePaneTitle }
}

export function resolveRuntimePaneTitleLeafIdFromRoot(
  root: TerminalPaneLayoutNode | null | undefined,
  runtimePaneId: string
): string | null {
  if (isTerminalLeafId(runtimePaneId)) {
    return runtimePaneId
  }
  const numericPaneId = Number(runtimePaneId)
  if (!Number.isInteger(numericPaneId) || numericPaneId < FIRST_PANE_ID) {
    return null
  }
  const leafIds = collectLeafIdsInReplayCreationOrder(root)
  return leafIds[numericPaneId - FIRST_PANE_ID] ?? null
}

/** Numeric slots survive pane closes with gaps, so only absent durable leaf ids prove removal. */
export function isRuntimePaneTitleOrphan(
  runtimePaneId: string,
  layoutLeafIds: ReadonlySet<string>
): boolean {
  return isTerminalLeafId(runtimePaneId) && !layoutLeafIds.has(runtimePaneId)
}

/**
 * Resolve a sparse live runtime pane slot through the tab's current PTY bindings.
 * PaneManager ids survive closes with gaps, while the live PTY list retains order.
 */
export function resolveRuntimePaneTitleLeafIdFromSparseSlots(args: {
  layout: Pick<TerminalLayoutSnapshot, 'ptyIdsByLeafId'> | undefined
  paneId: number
  liveSlotIds: number[]
  ptyIds: string[]
}): string | null {
  if (args.ptyIds.length !== args.liveSlotIds.length) {
    return null
  }
  const paneIndex = args.liveSlotIds.indexOf(args.paneId)
  const ptyId = paneIndex === -1 ? undefined : args.ptyIds[paneIndex]
  if (!ptyId) {
    return null
  }
  const boundLeafIds = Object.entries(args.layout?.ptyIdsByLeafId ?? {})
    .filter(([, boundPtyId]) => boundPtyId === ptyId)
    .map(([leafId]) => leafId)
  return boundLeafIds.length === 1 ? boundLeafIds[0] : null
}
