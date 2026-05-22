import type {
  ManagedPane,
  ManagedPaneInternal,
  PaneManagerOptions,
  PaneStyleOptions
} from './pane-manager-types'
import type { DragReorderCallbacks } from './pane-drag-reorder'
import { splitManagedPane } from './pane-split-close'

export type SplitPaneAroundLeafIdsOptions = {
  ratio?: number
  cwd?: string
  leafId?: string
  ptyId?: string
  placement?: 'before' | 'after'
}

type SplitPaneAroundLeafIdsArgs = {
  sourceLeafIds: readonly string[]
  fallbackPaneId: number
  direction: 'vertical' | 'horizontal'
  opts?: SplitPaneAroundLeafIdsOptions
  panes: Map<number, ManagedPaneInternal>
  root: HTMLElement
  styleOptions: PaneStyleOptions
  managerOptions: PaneManagerOptions
  getNumericIdForLeaf: (leafId: string) => number | null
  createPaneInternal: (leafIdHint?: string) => ManagedPaneInternal
  createDivider: (isVertical: boolean) => HTMLElement
  publishPaneCreated: (
    pane: ManagedPaneInternal,
    spawnHints?: Parameters<NonNullable<PaneManagerOptions['onPaneCreated']>>[1]
  ) => void
  getDragCallbacks: () => DragReorderCallbacks
  setActivePaneId: (paneId: number | null) => void
  isDestroyed: () => boolean
}

export function splitPaneAroundMountedSubtree(
  args: SplitPaneAroundLeafIdsArgs
): ManagedPane | null {
  // Why: live host reconciliation may need to add a sibling to an already
  // mounted split subtree; splitting only the anchor leaf corrupts the shape.
  const sourceContainer =
    findMountedSubtreeContainer(args.sourceLeafIds, args) ??
    args.panes.get(args.fallbackPaneId)?.container
  if (!sourceContainer) {
    return null
  }
  const createdPane = splitManagedPane({
    paneId: args.fallbackPaneId,
    direction: args.direction,
    opts: args.opts,
    sourceContainer,
    panes: args.panes,
    root: args.root,
    styleOptions: args.styleOptions,
    managerOptions: args.managerOptions,
    createPaneInternal: args.createPaneInternal,
    createDivider: args.createDivider,
    publishPaneCreated: args.publishPaneCreated,
    getDragCallbacks: args.getDragCallbacks,
    setActivePaneId: args.setActivePaneId,
    isDestroyed: args.isDestroyed
  })
  if (!createdPane || args.opts?.placement !== 'before') {
    return createdPane
  }

  const createdInternal = args.panes.get(createdPane.id)
  if (createdInternal) {
    placeCreatedPaneBeforeSource(sourceContainer, createdInternal.container)
  }
  return createdPane
}

function findMountedSubtreeContainer(
  sourceLeafIds: readonly string[],
  args: Pick<SplitPaneAroundLeafIdsArgs, 'getNumericIdForLeaf' | 'panes' | 'root'>
): HTMLElement | null {
  if (sourceLeafIds.length === 0) {
    return null
  }
  const expectedLeafIds = new Set(sourceLeafIds)
  const firstLeafId = sourceLeafIds[0]
  if (!firstLeafId) {
    return null
  }
  const firstPaneId = args.getNumericIdForLeaf(firstLeafId)
  const firstPane = firstPaneId === null ? null : args.panes.get(firstPaneId)
  let candidate: HTMLElement | null = firstPane?.container ?? null
  while (candidate && candidate !== args.root) {
    if (
      (candidate.classList.contains('pane') || candidate.classList.contains('pane-split')) &&
      setsEqual(leafIdsInContainer(candidate), expectedLeafIds)
    ) {
      return candidate
    }
    candidate = candidate.parentElement
  }
  return null
}

function leafIdsInContainer(container: HTMLElement): Set<string> {
  const leafIds = new Set<string>()
  if (container.classList.contains('pane') && container.dataset.leafId) {
    leafIds.add(container.dataset.leafId)
  }
  for (const pane of container.querySelectorAll<HTMLElement>('.pane[data-leaf-id]')) {
    if (pane.dataset.leafId) {
      leafIds.add(pane.dataset.leafId)
    }
  }
  return leafIds
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false
    }
  }
  return true
}

function placeCreatedPaneBeforeSource(
  sourceContainer: HTMLElement,
  createdContainer: HTMLElement
): boolean {
  const split = createdContainer.parentElement
  if (!split || sourceContainer.parentElement !== split) {
    return false
  }
  const divider = Array.from(split.children).find(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.classList.contains('pane-divider')
  )
  if (!divider) {
    return false
  }

  split.replaceChildren(createdContainer, divider, sourceContainer)
  return true
}
