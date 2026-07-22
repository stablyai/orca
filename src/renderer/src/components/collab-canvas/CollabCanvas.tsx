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
import { exportCollabBoardFromEditor } from '../../lib/collab-canvas/export-selection'
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
  selectGroupsForSession,
  selectUnifiedTabsForSession
} from '../../lib/collab-canvas/collab-canvas-session-selectors'
import { resolveLastAgentReply } from '../../lib/collab-canvas/resolve-last-agent-reply'
import { decideCollabAutoDraft } from '../../lib/collab-canvas/collab-auto-draft'
import { parseAgentBoardOps } from '../../lib/collab-canvas/parse-agent-board-ops'
import { applyAgentBoardOps } from '../../lib/collab-canvas/apply-agent-board-ops'
import { prepareReplyForSpeech } from '../../lib/voice/prepare-reply-for-speech'
import { mountAgentDraftOnEditor } from '../../lib/collab-canvas/agent-draft-shape-util'
import { buildCollabCanvasSchemaUtils } from '../../lib/collab-canvas/collab-canvas-sync-schema'
import {
  buildCanvasOmpAgentArgs,
  getCanvasBoardAgentTabId,
  setCanvasBoardAgentTabId
} from '../../lib/collab-canvas/canvas-agent-spawn'
import { collabCanvasOwnsAgentSession } from '../../../../shared/collab-canvas-binding'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
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
  // Why shapeUtils on useSync (not only <Tldraw>): remote store validates on
  // put — agent-draft must be in the schema. Must also include tldraw defaults
  // (see buildCollabCanvasSchemaUtils) or arrow migrations break mount.
  const collabSchemaUtils = useMemo(() => buildCollabCanvasSchemaUtils(), [])
  const store = useSync({
    uri,
    assets,
    shapeUtils: collabSchemaUtils.shapeUtils,
    bindingUtils: collabSchemaUtils.bindingUtils
  })

  const editorRef = useRef<Editor | null>(null)
  const awarenessSentRef = useRef<string | null>(null)
  /** Armed after Send — next working→done for this worktree auto-places write-back. */
  const awaitingReplyRef = useRef(false)
  const workingByPaneRef = useRef<Map<string, boolean>>(new Map())
  const placedDraftKeysRef = useRef<Set<string>>(new Set())
  const [sending, setSending] = useState(false)
  const [autoDraft, setAutoDraft] = useState(true)
  const [awareStatus, setAwareStatus] = useState<'idle' | 'sent' | 'no-terminal'>('idle')
  const [awaitingLabel, setAwaitingLabel] = useState(false)

  const isSession = binding.kind === 'session'
  const isPanel = binding.kind === 'panel'
  const ownsAgent = collabCanvasOwnsAgentSession(binding)
  /** Synthetic worktree key for inject payload on panel boards. */
  const injectWorktreeKey =
    binding.kind === 'session' ? binding.worktreeId : `panel:${binding.panelId}`
  const sessionWorktreeId = binding.kind === 'session' ? binding.worktreeId : null
  // Why stable empties: panel boards have no session worktree. Returning a fresh
  // `[]` from the selector every snapshot fails Object.is and infinite-loops
  // useSyncExternalStore (React #185) — same class as SidebarPanelRows /
  // pet-agent-ask. Module-level EMPTY_* is the fixed snapshot identity.
  const unifiedTabs = useAppStore((s) =>
    selectUnifiedTabsForSession(s.unifiedTabsByWorktree, sessionWorktreeId)
  )
  const groups = useAppStore((s) =>
    selectGroupsForSession(s.groupsByWorktree, sessionWorktreeId)
  )
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const [, bumpAgentBind] = useState(0)

  const resolveTerminalTabId = useCallback((): string | null => {
    if (binding.kind === 'panel') {
      return getCanvasBoardAgentTabId(binding.boardId)
    }
    if (!sessionWorktreeId) return null
    return resolveSessionAgentTerminalTabId({
      tabs: unifiedTabs,
      preferredTabIds: preferredTabIdsFromGroups(groups)
    })
  }, [binding, sessionWorktreeId, unifiedTabs, groups, bumpAgentBind])

  const spawnPanelAgent = useCallback(
    (fresh: boolean) => {
      if (binding.kind !== 'panel') return
      const worktreeId = activeWorktreeId
      if (!worktreeId) {
        toast('Open a workspace first so the board agent has a cwd')
        return
      }
      try {
        const result = launchAgentInNewTab({
          agent: 'omp',
          worktreeId,
          agentArgs: buildCanvasOmpAgentArgs(binding.boardId, { fresh }),
          launchSource: 'pet',
          // Tab title: not stock "omp" — matches pet's "Pet assistant" labeling.
          quickCommandLabel: 'Board Agent'
        })
        if (result?.tabId) {
          setCanvasBoardAgentTabId(binding.boardId, result.tabId)
          bumpAgentBind((n) => n + 1)
          setAwareStatus('sent')
          toast(fresh ? 'Fresh board agent spawned' : 'Board agent spawned')
        } else {
          toast('Failed to spawn board agent')
        }
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Spawn failed')
      }
    },
    [binding, activeWorktreeId]
  )

  const closePanelAgent = useCallback(() => {
    if (binding.kind !== 'panel') return
    setCanvasBoardAgentTabId(binding.boardId, null)
    bumpAgentBind((n) => n + 1)
    setAwareStatus('no-terminal')
    toast('Board agent unbound (close the omp tab manually if still open)')
  }, [binding])

  const applyAgentReplyToBoard = useCallback(
    (rawBody: string, sourceTurnId: string, opts?: { quiet?: boolean }) => {
      const editor = editorRef.current
      if (!editor) {
        if (!opts?.quiet) toast('Board editor not ready')
        return false
      }
      const { ops, proseWithoutFence } = parseAgentBoardOps(rawBody)
      if (ops.length > 0) {
        const result = applyAgentBoardOps(editor, binding.boardId, ops)
        if (!opts?.quiet) {
          toast(
            `Applied ${result.applied} board op(s)` +
              (result.geos || result.notes || result.drafts
                ? ` · geo ${result.geos} · note ${result.notes} · draft ${result.drafts}`
                : '')
          )
        }
        // If fence had only shapes and leftover prose is still useful, draft it too.
        const leftover = prepareReplyForSpeech(proseWithoutFence).trim()
        if (leftover && leftover.length > 40 && !ops.some((o) => o.op === 'draft')) {
          mountAgentDraftOnEditor(editor, {
            boardId: binding.boardId,
            body: leftover,
            placement: { x: 40, y: 40 },
            sourceTurnId
          })
        }
        return true
      }

      const cleaned = prepareReplyForSpeech(rawBody).trim() || rawBody.trim()
      if (!cleaned) {
        if (!opts?.quiet) toast('Nothing to place as draft')
        return false
      }
      const bounds = editor.getSelectionPageBounds()
      const placement = bounds
        ? {
            x: bounds.x + bounds.w + 24,
            y: bounds.y,
            w: 300,
            h: Math.min(280, 80 + cleaned.length / 2)
          }
        : { x: 40, y: 40, w: 300, h: Math.min(280, 80 + cleaned.length / 2) }
      mountAgentDraftOnEditor(editor, {
        boardId: binding.boardId,
        body: cleaned,
        placement,
        sourceTurnId
      })
      if (!opts?.quiet) toast('Placed agent-draft on board')
      return true
    },
    [binding.boardId]
  )

  const placeDraftBody = useCallback(
    (body: string, sourceTurnId: string) => {
      applyAgentReplyToBoard(body, sourceTurnId)
    },
    [applyAgentReplyToBoard]
  )

  const tryAwareness = useCallback(() => {
    const key =
      binding.kind === 'session'
        ? `${binding.worktreeId}:${binding.boardId}`
        : `panel:${binding.panelId}:${binding.boardId}`
    if (awarenessSentRef.current === key) return
    const tabId = resolveTerminalTabId()
    if (!tabId) {
      setAwareStatus('no-terminal')
      return
    }
    const result = injectSessionBoardAwareness({
      boardId: binding.boardId,
      worktreeId: injectWorktreeKey,
      tabId
    })
    if (result.ok) {
      awarenessSentRef.current = key
      setAwareStatus('sent')
    } else {
      setAwareStatus('no-terminal')
    }
  }, [binding, resolveTerminalTabId, injectWorktreeKey])

  // Awareness when a terminal/agent is available for this binding.
  useEffect(() => {
    const t = window.setTimeout(() => tryAwareness(), 400)
    return () => window.clearTimeout(t)
  }, [tryAwareness, binding.boardId])

  // Auto write-back: after Send, next working→done for the bound agent lands on the board.
  useEffect(() => {
    if (!autoDraft) return
    const tabId = resolveTerminalTabId()
    const wt = sessionWorktreeId

    for (const entry of Object.values(agentStatusByPaneKey)) {
      if (!entry) continue
      const matches =
        (tabId != null &&
          (entry.tabId === tabId || entry.paneKey.startsWith(`${tabId}:`))) ||
        (wt != null && entry.worktreeId === wt && isSession)
      if (!matches) continue

      const wasWorking = workingByPaneRef.current.get(entry.paneKey) === true
      workingByPaneRef.current.set(entry.paneKey, entry.state === 'working')

      const decision = decideCollabAutoDraft({
        armed: awaitingReplyRef.current,
        wasWorking,
        state: entry.state,
        reply: entry.lastAssistantMessage,
        alreadyPlacedKeys: placedDraftKeysRef.current,
        paneKey: entry.paneKey
      })
      if (!decision.place) continue

      placedDraftKeysRef.current.add(decision.dedupeKey)
      awaitingReplyRef.current = false
      setAwaitingLabel(false)
      applyAgentReplyToBoard(decision.body, `auto:${entry.paneKey}`, { quiet: false })
    }
  }, [
    autoDraft,
    agentStatusByPaneKey,
    resolveTerminalTabId,
    applyAgentReplyToBoard,
    sessionWorktreeId,
    isSession
  ])

  const handlePlaceDraftFromClipboard = useCallback(async () => {
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
    placeDraftBody(body, 'clipboard')
  }, [placeDraftBody])

  const handlePlaceDraftFromLastReply = useCallback(() => {
    const tabId = resolveTerminalTabId()
    const hit = resolveLastAgentReply({
      worktreeId: sessionWorktreeId ?? injectWorktreeKey,
      preferredTabId: tabId,
      entries: Object.values(agentStatusByPaneKey).filter(
        (e): e is NonNullable<typeof e> => Boolean(e)
      )
    })
    if (!hit) {
      toast('No agent reply found yet')
      return
    }
    placeDraftBody(hit.body, `agent:${hit.paneKey}`)
  }, [
    sessionWorktreeId,
    injectWorktreeKey,
    resolveTerminalTabId,
    agentStatusByPaneKey,
    placeDraftBody
  ])

  const handleSendToAgent = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) {
      toast('Board editor not ready')
      return
    }
    let tabId = resolveTerminalTabId()
    if (!tabId && isPanel) {
      spawnPanelAgent(false)
      tabId = resolveTerminalTabId()
    }
    if (!tabId) {
      toast(
        isPanel
          ? 'Spawn a board agent first (or open a workspace and retry)'
          : 'No terminal in this workspace — open Hermes/omp first'
      )
      setAwareStatus('no-terminal')
      return
    }

    setSending(true)
    try {
      tryAwareness()

      const snap = await exportCollabBoardFromEditor(editor, {
        boardId: binding.boardId,
        worktreeId: injectWorktreeKey
      })
      if (snap.boardShapeIds.length === 0) {
        toast('Board is empty — draw something first')
        return
      }

      const boardMat = await materializeCollabAtlasToTempFile(snap.boardAtlasDataUri)
      if (!boardMat.ok && snap.boardAtlasDataUri) {
        toast(`Board screenshot path failed (${boardMat.reason})`)
      }
      let selectionPath: string | null = null
      if (snap.selectionAtlasDataUri) {
        const selMat = await materializeCollabAtlasToTempFile(snap.selectionAtlasDataUri)
        if (selMat.ok) {
          selectionPath = selMat.filePath
        }
      }

      const payload = buildCollabCanvasInjectPayload(snap, {
        boardFilePath: boardMat.ok ? boardMat.filePath : null,
        selectionFilePath: selectionPath
      })
      const result = injectCollabPayloadIntoTerminal(payload, { tabId })
      if (!result.ok) {
        toast(`Inject failed: ${result.reason}`)
        return
      }
      awaitingReplyRef.current = autoDraft
      setAwaitingLabel(autoDraft)
      const focus = snap.hasSelection ? ' + selection focus' : ''
      toast(
        boardMat.ok
          ? `Sent full-board screenshot${focus}` + (autoDraft ? ' · auto-draft armed' : '')
          : 'Sent board digest (screenshot path failed)'
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`Send failed: ${msg}`)
    } finally {
      setSending(false)
    }
  }, [
    binding.boardId,
    injectWorktreeKey,
    resolveTerminalTabId,
    tryAwareness,
    autoDraft,
    isPanel,
    spawnPanelAgent
  ])

  if (!valid) {
    return (
      <div className="flex h-full w-full items-center justify-center p-4 text-sm text-muted-foreground">
        Invalid board id “{binding.boardId}”.
      </div>
    )
  }

  const panelAgentBound = isPanel && Boolean(getCanvasBoardAgentTabId(binding.boardId))

  return (
    <div className="relative flex h-full w-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-background/90 px-2 py-1.5 text-xs">
        <span className="font-medium text-foreground">
          {isPanel ? 'Panel board' : 'Session board'}
        </span>
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
          {isPanel
            ? panelAgentBound
              ? '· board agent bound'
              : '· no board agent'
            : awareStatus === 'sent'
              ? '· session agent aware'
              : awareStatus === 'no-terminal'
                ? '· no terminal yet'
                : '· binding session'}
          {awaitingLabel ? (
            <span className="text-sky-600 dark:text-sky-400"> · awaiting reply → board</span>
          ) : null}
        </span>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          {ownsAgent ? (
            <>
              <button
                type="button"
                className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted"
                onClick={() => spawnPanelAgent(false)}
              >
                Spawn agent
              </button>
              <button
                type="button"
                className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted"
                onClick={() => spawnPanelAgent(true)}
                title="New omp session in the same canvas session-dir"
              >
                Fresh session
              </button>
              <button
                type="button"
                className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted"
                onClick={() => closePanelAgent()}
              >
                Close session
              </button>
            </>
          ) : null}
          <label
            className="flex cursor-pointer items-center gap-1 text-muted-foreground"
            title="After Send, place the next finished agent turn on the board"
          >
            <input
              type="checkbox"
              className="accent-primary"
              checked={autoDraft}
              onChange={(e) => setAutoDraft(e.target.checked)}
            />
            Auto draft
          </label>
          <button
            type="button"
            className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted"
            onClick={() => handlePlaceDraftFromLastReply()}
          >
            Draft from last reply
          </button>
          <button
            type="button"
            className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted"
            onClick={() => void handlePlaceDraftFromClipboard()}
          >
            Draft from clipboard
          </button>
          <button
            type="button"
            className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
            disabled={sending}
            onClick={() => void handleSendToAgent()}
            title="Full board screenshot for vision + selection coords when focused"
          >
            {sending ? 'Sending…' : isPanel ? 'Send to board agent' : 'Send to session'}
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {/* tldraw owns pointer events wholesale — including pen pressure and palm
            rejection, which is what makes the S Pen work on the tablet WebView
            without us hand-rolling input handling. */}
        <Tldraw
          store={store}
          shapeUtils={collabSchemaUtils.shapeUtils}
          bindingUtils={collabSchemaUtils.bindingUtils}
          onMount={(editor) => {
            editorRef.current = editor
          }}
        />
      </div>
    </div>
  )
}
