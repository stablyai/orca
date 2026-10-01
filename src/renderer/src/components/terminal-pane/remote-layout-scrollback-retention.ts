import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { collectLeafIdsInOrder } from './terminal-layout-leaf-ids'
import { mergeCapturedLeafState } from './merge-captured-leaf-state'

/**
 * Carry this client's captured scrollback into the host's layout for a replaced tab.
 *
 * Why: the pull replaces a replaced tab's layout wholesale, and a park capture does not bump
 * `tab.generation`, so a just-parked tab is not in `locallyPreservedTabIds` and its
 * `buffersByLeafId` — the only client-side copy of a remote pane's scrollback — goes with it.
 * The host is authoritative for structure and never mints scrollback of its own: its copy is
 * only ever some client's earlier upload. So take `root`, `ptyIdsByLeafId`, titles and the
 * active/expanded leaves from the host verbatim, and let the client fill in content the host's
 * copy lacks. Structure from the host, bytes from whoever still has them.
 *
 * Why local wins a conflict: neither copy is then the only one, so neither choice destroys
 * evidence — but remote-wins would overwrite the tail captured since this client's last upload
 * and then propagate that regression back on the next replace-session patch.
 *
 * Why filtered to the host's leaves: it keeps the client from resurrecting a leaf the host
 * retired, and from contributing anything for a split the host added while we were away.
 */
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
