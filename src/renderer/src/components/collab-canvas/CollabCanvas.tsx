/**
 * The collab whiteboard — one component, two surfaces.
 *
 * A board is a tldraw canvas whose document lives in the mesh sync server, so
 * the desktop tab, a User Panel tile and the tablet route all edit ONE document
 * live. The `binding` decides which agent the board talks to; it never decides
 * how the document is transported (see `shared/collab-canvas-binding.ts`).
 *
 * G2-P: session boards wire awareness + "Send to session" into the existing
 * worktree terminal (no second omp). Agent replies mount as agent-draft shapes.
 *
 * Naming: Orca's existing `panel-canvas` subsystem is the TILING layout. This
 * is the drawing surface. They are unrelated.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Tldraw, type Editor } from 'tldraw'
import { useSync } from '@tldraw/sync'
import { toast } from 'sonner'
import 'tldraw/tldraw.css'
import type { CollabCanvasBinding } from '../../../../shared/collab-canvas-binding'
import { collabCanvasRoomUri } from '../../../../shared/collab-canvas-binding'
import {
  collabCanvasSyncOrigin,
  isValidCollabCanvasBoardId
} from '../../lib/collab-canvas/collab-canvas-sync-config'
import { createInlineAssetStore } from '../../lib/collab-canvas/collab-canvas-assets'
import { buildCollabCanvasInjectPayload } from '../../lib/collab-canvas/collab-canvas-bridge'
import { exportCollabSelectionFromEditor } from '../../lib/collab-canvas/export-selection'
import { materializeCollabAtlasToTempFile } from '../../lib/collab-canvas/materialize-atlas'
import {
  injectCollabPayloadIntoTerminal,
  injectSessionBoardAwareness
} from '../../lib/collab-canvas/session-inject'
import {
  preferredTabIdsFromGroups,
  resolveSessionAgentTerminalTabId
} from '../../lib/collab-canvas/resolve-session-agent-tab'
import {
  COLLAB_CANVAS_SHAPE_UTILS,
  mountAgentDraftOnEditor
} from '../../lib/collab-canvas/agent-draft-shape-util'
import { useAppStore } from '@/store'

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

  const editorRef = useRef<Editor | null>(null)
  const awarenessSentRef = useRef<string | null>(null)
  const [sending, setSending] = useState(false)
  const [awareStatus, setAwareStatus] = useState<'idle' | 'sent' | 'no-terminal'>('idle')

  const worktreeId = binding.kind === 'session' ? binding.worktreeId : null
  const unifiedTabs = useAppStore((s) =>
    worktreeId ? (s.unifiedTabsByWorktree[worktreeId] ?? []) : []
  )
  const groups = useAppStore((s) => (worktreeId ? (s.groupsByWorktree[worktreeId] ?? []) : []))

  const resolveTerminalTabId = useCallback((): string | null => {
    if (!worktreeId) return null
    return resolveSessionAgentTerminalTabId({
      tabs: unifiedTabs,
      preferredTabIds: preferredTabIdsFromGroups(groups)
    })
  }, [worktreeId, unifiedTabs, groups])

  const tryAwareness = useCallback(() => {
    if (binding.kind !== 'session') return
    const key = `${binding.worktreeId}:${binding.boardId}`
    if (awarenessSentRef.current === key) return
    const tabId = resolveTerminalTabId()
    if (!tabId) {
      setAwareStatus('no-terminal')
      return
    }
    const result = injectSessionBoardAwareness({
      boardId: binding.boardId,
      worktreeId: binding.worktreeId,
      tabId
    })
    if (result.ok) {
      awarenessSentRef.current = key
      setAwareStatus('sent')
    } else {
      setAwareStatus('no-terminal')
    }
  }, [binding, resolveTerminalTabId])

  // Session awareness: once a board mounts beside a worktree, tell the live agent.
  const sessionBoardKey =
    binding.kind === 'session' ? `${binding.worktreeId}:${binding.boardId}` : null
  useEffect(() => {
    if (!sessionBoardKey) return
    // Defer slightly so terminal panes finish registering paste listeners.
    const t = window.setTimeout(() => tryAwareness(), 400)
    return () => window.clearTimeout(t)
  }, [sessionBoardKey, tryAwareness])

  const handlePlaceDraftFromClipboard = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) {
      toast('Board editor not ready')
      return
    }
    let body = ''
    try {
      body = (await navigator.clipboard.readText()).trim()
    } catch {
      toast('Could not read clipboard')
      return
    }
    if (!body) {
      toast('Clipboard is empty — copy an agent reply first')
      return
    }
    const bounds = editor.getSelectionPageBounds()
    const placement = bounds
      ? { x: bounds.x + bounds.w + 24, y: bounds.y, w: 300, h: Math.min(280, 80 + body.length / 2) }
      : { x: 40, y: 40, w: 300, h: Math.min(280, 80 + body.length / 2) }
    mountAgentDraftOnEditor(editor, {
      boardId: binding.boardId,
      body,
      placement,
      sourceTurnId: 'clipboard'
    })
    toast('Placed agent-draft on board')
  }, [binding.boardId])

  const handleSendToSession = useCallback(async () => {
    if (binding.kind !== 'session') {
      toast('Send to session is only for session boards')
      return
    }
    const editor = editorRef.current
    if (!editor) {
      toast('Board editor not ready')
      return
    }
    const tabId = resolveTerminalTabId()
    if (!tabId) {
      toast('No terminal in this workspace — open Hermes/omp first')
      setAwareStatus('no-terminal')
      return
    }

    setSending(true)
    try {
      // Ensure awareness has fired before the first selection inject.
      tryAwareness()

      const selection = await exportCollabSelectionFromEditor(editor, {
        boardId: binding.boardId,
        worktreeId: binding.worktreeId,
        includeAtlas: true
      })
      if (selection.selectedShapeIds.length === 0) {
        toast('Select shapes on the board first')
        return
      }
      // Materialize PNG so the agent gets a real image path (terminal screenshot path),
      // not just "atlas: attached" prose it cannot see.
      const atlas = await materializeCollabAtlasToTempFile(selection.atlasDataUri)
      if (!atlas.ok && selection.atlasDataUri) {
        toast(`Sketch image path failed (${atlas.reason}) — sending text digest only`)
      }
      const payload = buildCollabCanvasInjectPayload(selection, {
        atlasFilePath: atlas.ok ? atlas.filePath : null
      })
      const result = injectCollabPayloadIntoTerminal(payload, { tabId })
      if (!result.ok) {
        toast(`Inject failed: ${result.reason}`)
        return
      }
      toast(
        atlas.ok
          ? 'Sent sketch + path to session agent'
          : 'Sent selection text to session agent'
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`Send failed: ${msg}`)
    } finally {
      setSending(false)
    }
  }, [binding, resolveTerminalTabId, tryAwareness])

  if (!valid) {
    return (
      <div className="flex h-full w-full items-center justify-center p-4 text-sm text-muted-foreground">
        Invalid board id “{binding.boardId}”.
      </div>
    )
  }

  const isSession = binding.kind === 'session'

  return (
    <div className="relative flex h-full w-full flex-col">
      {isSession ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-background/90 px-2 py-1.5 text-xs">
          <span className="font-medium text-foreground">Collab board</span>
          <span className="text-muted-foreground truncate" title={binding.boardId}>
            {binding.boardId}
          </span>
          <span
            className={
              awareStatus === 'sent'
                ? 'text-emerald-600 dark:text-emerald-400'
                : awareStatus === 'no-terminal'
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-muted-foreground'
            }
          >
            {awareStatus === 'sent'
              ? '· session agent aware'
              : awareStatus === 'no-terminal'
                ? '· no terminal yet'
                : '· binding session'}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted"
              onClick={() => void handlePlaceDraftFromClipboard()}
              title="Paste clipboard text as a provisional agent-draft shape"
            >
              Draft from clipboard
            </button>
            <button
              type="button"
              className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
              disabled={sending}
              onClick={() => void handleSendToSession()}
            >
              {sending ? 'Sending…' : 'Send to session'}
            </button>
          </div>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {/* tldraw owns pointer events wholesale — including pen pressure and palm
            rejection, which is what makes the S Pen work on the tablet WebView
            without us hand-rolling input handling. */}
        <Tldraw
          store={store}
          shapeUtils={[...COLLAB_CANVAS_SHAPE_UTILS]}
          onMount={(editor) => {
            editorRef.current = editor
          }}
        />
      </div>
    </div>
  )
}
