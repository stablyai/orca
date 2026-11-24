import { collectLeafIds } from '../../../../../shared/workspace-layout/terminal-topology/terminal-pane-layout-tree'
import { resolveRootlessTerminalLayoutLeafId } from '../../../../../shared/workspace-layout/terminal-topology/terminal-pane-tree'
import type { LocalScrollbackSnapshots } from '@/runtime/hosted-terminals/hydration/host-terminal-scrollback-hydration'
import type { TerminalLayoutSnapshot } from '../../../../../shared/workspace-layout/terminal-tab-types'

export function clearRetainedInlineScrollback(
  layout: TerminalLayoutSnapshot,
  leafId: string
): TerminalLayoutSnapshot {
  if (!layout.buffersByLeafId || !Object.hasOwn(layout.buffersByLeafId, leafId)) {
    return layout
  }
  const buffersByLeafId = { ...layout.buffersByLeafId }
  delete buffersByLeafId[leafId]
  const nextLayout = { ...layout }
  if (Object.keys(buffersByLeafId).length > 0) {
    nextLayout.buffersByLeafId = buffersByLeafId
  } else {
    delete nextLayout.buffersByLeafId
  }
  return nextLayout
}

export function hydrateTerminalScrollbackRefs(
  layout: TerminalLayoutSnapshot,
  snapshots: LocalScrollbackSnapshots
): {
  layout: TerminalLayoutSnapshot
  hydrated: boolean
} {
  const refs = layout.scrollbackRefsByLeafId
  if (!refs || Object.keys(refs).length === 0) {
    return { layout, hydrated: false }
  }

  const buffers = { ...layout.buffersByLeafId }
  let hydrated = false
  for (const [leafId, ref] of Object.entries(refs)) {
    if (buffers[leafId] !== undefined) {
      continue
    }
    const snapshot = snapshots[leafId]
    if (snapshot?.ref === ref) {
      buffers[leafId] = snapshot.buffer
      hydrated = true
    }
  }

  return hydrated
    ? { layout: { ...layout, buffersByLeafId: buffers }, hydrated }
    : { layout, hydrated }
}

/** A replacement manager can reuse inline bytes whose only surviving owner is this component. */
export function restoreRetainedInlineScrollback(
  layout: TerminalLayoutSnapshot,
  retained: TerminalLayoutSnapshot | undefined,
  localOnly: Record<string, string> | undefined,
  cleared: ReadonlySet<string> | undefined
): TerminalLayoutSnapshot {
  if (!retained?.buffersByLeafId) {
    return layout
  }
  const leaves = layout.root
    ? collectLeafIds(layout.root)
    : [resolveRootlessTerminalLayoutLeafId(layout)].filter(
        (leafId): leafId is string => leafId !== null
      )
  let buffers: Record<string, string> | undefined
  for (const leafId of leaves) {
    const buffer = retained.buffersByLeafId[leafId]
    if (
      buffer !== undefined &&
      retained.scrollbackRefsByLeafId?.[leafId] === undefined &&
      layout.buffersByLeafId?.[leafId] === undefined &&
      layout.scrollbackRefsByLeafId?.[leafId] === undefined &&
      localOnly?.[leafId] === undefined &&
      !cleared?.has(leafId)
    ) {
      buffers ??= { ...layout.buffersByLeafId }
      buffers[leafId] = buffer
    }
  }
  return buffers ? { ...layout, buffersByLeafId: buffers } : layout
}
