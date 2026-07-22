/**
 * The collab whiteboard — one component, two surfaces.
 *
 * A board is a tldraw canvas whose document lives in the mesh sync server, so
 * the desktop tab, a User Panel tile and the tablet route all edit ONE document
 * live. The `binding` decides which agent the board talks to; it never decides
 * how the document is transported (see `shared/collab-canvas-binding.ts`).
 *
 * Naming: Orca's existing `panel-canvas` subsystem is the TILING layout. This
 * is the drawing surface. They are unrelated.
 */
import { useMemo } from 'react'
import { Tldraw } from 'tldraw'
import { useSync } from '@tldraw/sync'
import 'tldraw/tldraw.css'
import type { CollabCanvasBinding } from '../../../../shared/collab-canvas-binding'
import { collabCanvasRoomUri } from '../../../../shared/collab-canvas-binding'
import {
  collabCanvasSyncOrigin,
  isValidCollabCanvasBoardId
} from '../../lib/collab-canvas/collab-canvas-sync-config'
import { createInlineAssetStore } from '../../lib/collab-canvas/collab-canvas-assets'

export type CollabCanvasProps = {
  binding: CollabCanvasBinding
  /** Paired host endpoint, used to derive the mesh sync address. */
  hostEndpoint?: string | null
  /** Operator override of the sync origin (settings). */
  syncOriginOverride?: string | null
}

export function CollabCanvas({
  binding,
  hostEndpoint,
  syncOriginOverride
}: CollabCanvasProps): React.JSX.Element {
  const uri = useMemo(
    () => collabCanvasRoomUri(collabCanvasSyncOrigin(hostEndpoint, syncOriginOverride), binding.boardId),
    [hostEndpoint, syncOriginOverride, binding.boardId]
  )

  // Why validate in the renderer as well as the server: the server answers a
  // bad board id by destroying the socket, which surfaces here as an endless
  // reconnect rather than an error. Better to say so.
  const valid = isValidCollabCanvasBoardId(binding.boardId)

  // Stable across renders: a new asset store identity would churn the sync client.
  const assets = useMemo(() => createInlineAssetStore(), [])
  const store = useSync({ uri, assets })

  if (!valid) {
    return (
      <div className="flex h-full w-full items-center justify-center p-4 text-sm text-muted-foreground">
        Invalid board id “{binding.boardId}”.
      </div>
    )
  }

  return (
    <div className="h-full w-full">
      {/* tldraw owns pointer events wholesale — including pen pressure and palm
          rejection, which is what makes the S Pen work on the tablet WebView
          without us hand-rolling input handling. */}
      <Tldraw store={store} />
    </div>
  )
}
