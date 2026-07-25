// Where the collab canvas sync server lives.
//
// Boards are multiplayer: the authoritative document lives in the self-hosted
// tldraw sync server (meshina `sidecars/collab-canvas-sync/`), NOT in a local
// file. The desktop and the tablet join the same room, which is the only way
// ink drawn on the tablet mid-session lands on the desktop.
//
// Endpoint resolution follows `lib/voice/mesh-speech-config.ts`: derive the
// host from the paired host endpoint when there is one, fall back to the mesh
// default otherwise. Endpoints are host-configurable by standing operator
// direction — never hardcode a bare IP as the only option.

import { extractMeshHost } from '../voice/mesh-speech-config'

/** Default sync host — node-a (Synapse), where the sidecar runs. Used only
 *  when the renderer has no paired host to derive a mesh address from. */
export const DEFAULT_COLLAB_CANVAS_SYNC_HOST = 'node-a'

/** Matches `COLLAB_CANVAS_SYNC_PORT` in the sidecar. */
export const COLLAB_CANVAS_SYNC_PORT = 5858

/** Operator override, so a board can point at a different sync server without
 *  a rebuild. Same storage-key convention as `KOKORO_VOICE_STORAGE_KEY`. */
export const COLLAB_CANVAS_SYNC_ORIGIN_STORAGE_KEY = 'orca:collabCanvasSyncOrigin'

/** Board ids become a sqlite filename on the server, which independently
 *  rejects anything outside this alphabet. Mirrors `normalizePinnedCanvasPanels`
 *  in `src/shared/pinned-canvas-panels.ts` — validate here too so a bad id
 *  fails in the UI instead of as a silently destroyed socket. */
const BOARD_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

export function isValidCollabCanvasBoardId(boardId: string): boolean {
  return BOARD_ID_PATTERN.test(boardId)
}

/** WebSocket origin of the sync server for a paired host endpoint.
 *
 *  `override` wins when set (operator setting), then the paired host's mesh
 *  address, then the default node. Returns an origin with no trailing slash —
 *  `collabCanvasRoomUri` appends the room path. */
export function collabCanvasSyncOrigin(
  hostEndpoint: string | null | undefined,
  override?: string | null
): string {
  const trimmedOverride = override?.trim()
  if (trimmedOverride) {
    // Why tolerated rather than parsed strictly: the operator may type
    // `node-a:5858` or a full `ws://…` URL, and both should work.
    if (/^wss?:\/\//.test(trimmedOverride)) {
      return trimmedOverride.replace(/\/+$/, '')
    }
    return `ws://${trimmedOverride.replace(/\/+$/, '')}`
  }

  const host = extractMeshHost(hostEndpoint) ?? DEFAULT_COLLAB_CANVAS_SYNC_HOST
  return `ws://${host}:${COLLAB_CANVAS_SYNC_PORT}`
}
