import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { collectLeafIdsInOrder } from './terminal-layout-leaf-ids'
import { mergeCapturedLeafState } from './merge-captured-leaf-state'

/** Host owns layout structure; preserve local captured bytes only for its surviving leaves. Park does not bump generation, so wholesale pulls otherwise erase newer local tails and propagate stale uploads. */
export function retainLocalScrollbackInRemoteLayout(
  local: TerminalLayoutSnapshot | undefined,
  remote: TerminalLayoutSnapshot
): TerminalLayoutSnapshot {
  if (!local?.buffersByLeafId && !local?.scrollbackRefsByLeafId) {
    return remote
  }
  const currentLeafIds = new Set(collectLeafIdsInOrder(remote.root))
  if (currentLeafIds.size === 0) {
    return remote
  }
  const buffersByLeafId = mergeCapturedLeafState({
    prior: remote.buffersByLeafId,
    fresh: local.buffersByLeafId ?? {},
    currentLeafIds
  })
  const scrollbackRefsByLeafId = mergeCapturedLeafState({
    prior: remote.scrollbackRefsByLeafId,
    fresh: local.scrollbackRefsByLeafId ?? {},
    currentLeafIds
  })
  const retained = { ...remote }
  if (Object.keys(buffersByLeafId).length > 0) {
    retained.buffersByLeafId = buffersByLeafId
  } else {
    delete retained.buffersByLeafId
  }
  if (Object.keys(scrollbackRefsByLeafId).length > 0) {
    retained.scrollbackRefsByLeafId = scrollbackRefsByLeafId
  } else {
    delete retained.scrollbackRefsByLeafId
  }
  return retained
}
