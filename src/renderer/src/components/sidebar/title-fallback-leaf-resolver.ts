import { FIRST_PANE_ID } from '../../../../shared/pane-key'
import {
  resolveRuntimePaneTitleLeafIdFromRoot,
  resolveRuntimePaneTitleLeafIdFromSparseSlots,
  collectRuntimePaneLeafIds
} from '../../../../shared/runtime-pane-title-leaf-id'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'

/** Map one tab's runtime pane-title slots to layout leaves; `allowPositional` false answers null instead of guessing by slot position. */
export function createTitleFallbackLeafResolver(
  layout: TerminalLayoutSnapshot | undefined,
  ptyIds: string[],
  paneTitleEntries: [string, string][],
  allowPositional = true
): (paneId: number, title: string) => string | null {
  const leafIds = collectRuntimePaneLeafIds(layout?.root ?? null)
  const liveSlotIds = paneTitleEntries
    .map(([paneId]) => Number(paneId))
    .filter((paneId) => paneId >= FIRST_PANE_ID)
  // Only dense live IDs retain mount/replay creation order; closing a pane makes IDs sparse.
  const liveSlotsAreDense =
    liveSlotIds.length === leafIds.length &&
    liveSlotIds.every((paneId, index) => paneId === FIRST_PANE_ID + index)
  return (paneId, title) =>
    resolveLeafIdForTitleFallback({
      layout,
      leafIds,
      ptyIds,
      liveSlotIds,
      liveSlotsAreDense,
      allowPositional,
      paneId,
      title
    })
}

/** Map negative parked slots by leaf traversal and live IDs by creation/PTY bindings; sorting both together misattributes sibling titles. */
function resolveLeafIdForTitleFallback(args: {
  layout: TerminalLayoutSnapshot | undefined
  leafIds: string[]
  ptyIds: string[]
  liveSlotIds: number[]
  liveSlotsAreDense: boolean
  allowPositional: boolean
  paneId: number
  title: string
}): string | null {
  if (args.leafIds.length === 1) {
    return args.leafIds[0]
  }
  if (args.paneId < FIRST_PANE_ID) {
    // Parked slots are defined off the in-order leaf list, so invert that definition.
    return args.leafIds[-args.paneId - 1] ?? null
  }
  if (args.liveSlotsAreDense) {
    const creationOrderLeafId = resolveRuntimePaneTitleLeafIdFromRoot(
      args.layout?.root,
      String(args.paneId)
    )
    if (creationOrderLeafId) {
      return creationOrderLeafId
    }
  }

  // Sparse IDs after pane closure need durable PTY-to-leaf bindings rather than layout-position guesses.
  const ptyBoundLeafId = resolveRuntimePaneTitleLeafIdFromSparseSlots({
    layout: args.layout,
    paneId: args.paneId,
    liveSlotIds: args.liveSlotIds,
    ptyIds: args.ptyIds
  })
  if (ptyBoundLeafId) {
    return ptyBoundLeafId
  }

  const matchingTitleLeafIds = Object.entries(args.layout?.titlesByLeafId ?? {})
    .filter(([, title]) => title === args.title)
    .map(([leafId]) => leafId)
  if (matchingTitleLeafIds.length === 1) {
    return matchingTitleLeafIds[0]
  }

  if (!args.allowPositional) {
    return null
  }
  // Fallback indexing uses only live slots; parked slots belong to a separate ID space.
  const paneIndex = args.liveSlotIds.indexOf(args.paneId)
  return paneIndex !== -1 ? (args.leafIds[paneIndex] ?? null) : null
}
