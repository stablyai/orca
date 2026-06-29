import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import { APP_MENU_PASTE_EVENT } from '@/lib/app-menu-paste'
import type { TuiAgent } from '../../../../shared/types'
import type { NativeChatSession } from '../../../../shared/native-chat-types'
import { resolveNativeChatSession } from './native-chat-pane-resolution'
import { useNativeChatLiveSession } from './use-native-chat-live-session'
import { selectNativeChatViewState } from './native-chat-view-state'
import { NativeChatMessageList } from './NativeChatMessageList'
import { NativeChatComposer, type NativeChatComposerHandle } from './NativeChatComposer'
import { useNativeChatFontScale } from './use-native-chat-font-scale'
import { useNativeChatCanSend } from './use-native-chat-can-send'
import { NativeChatInteractiveCard } from './NativeChatInteractiveCard'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import { useNativeChatInteractiveSend } from './use-native-chat-interactive-send'
import { findTabAgentEntry } from './native-chat-tab-agent-entry'
import {
  shouldClearNativeChatWorkingSuppression,
  shouldShowNativeChatWorking
} from './native-chat-working-suppression'
import {
  applyCommandMarkerBoundaries,
  appendPendingSendCache,
  commandMarkersAsMessages,
  appendCommandMarkerCache,
  pendingSendsAsMessages,
  prunePendingSends,
  readCommandMarkerCache,
  readPendingSendCache,
  writePendingSendCache,
  type NativeChatCommandMarker,
  type NativeChatPendingSend
} from './native-chat-pending'
import {
  deriveNativeChatStreamingText,
  nativeChatStreamingMessage
} from '../../../../shared/native-chat-streaming'
import {
  shouldFocusNativeChatPaneFromPointerTarget,
  shouldRedirectNativeChatTyping
} from './native-chat-typing-redirect'
import { useNativeChatContextMenu } from './use-native-chat-context-menu'
import type { NativeChatContextMenuActions } from './use-native-chat-context-menu'
import { isMacPlatform } from './native-chat-shortcut'

const NATIVE_CHAT_CONTEXT_PASTE_MAX_BYTES = 16 * 1024 * 1024
const emptyNativeChatContextMenuActions: Omit<NativeChatContextMenuActions, 'onPaste'> = {
  onSplitRight: () => {},
  onSplitDown: () => {},
  canEqualizePaneSizes: false,
  onEqualizePaneSizes: () => {},
  canExpandPane: false,
  isPaneExpanded: false,
  onToggleExpand: () => {},
  onForkAgentSession: () => {},
  onSetTitle: () => {},
  onCopyTerminalId: () => {},
  onCopyPaneId: () => {},
  canClosePane: false,
  onClosePane: () => {}
}

export type NativeChatViewProps = {
  /** The terminal tab hosting the agent. paneKey is `${tabId}:${leafId}`. */
  terminalTabId: string
  /** Specific split leaf this chat surface replaces. */
  paneKey?: string
  /** PTY bound to `paneKey`, used for composer and interactive-card sends. */
  targetPtyId?: string | null
  /** Launch-time agent hint from the TerminalTab, when Orca started one. */
  launchAgent?: TuiAgent | null
  /** Return this pane to the hosted terminal surface. */
  onSwitchToTerminal?: () => void
  contextMenuActions?: Omit<NativeChatContextMenuActions, 'onPaste'>
}

/**
 * Native chat surface for an agent terminal. Resolves the pane to its agent +
 * session id, streams the assembled conversation via the U4 live-session hook,
 * and renders the message list, live status, and all empty/loading/error
 * states. When no session id is known yet the hook surfaces live hook state on
 * an empty transcript; a true scrollback-scrape fallback (U6) is wired but only
 * runs when scrollback is obtainable — it degrades to the empty state otherwise.
 */
export default function NativeChatView({
  terminalTabId,
  paneKey: preferredPaneKey,
  targetPtyId = null,
  launchAgent,
  onSwitchToTerminal,
  contextMenuActions
}: NativeChatViewProps): React.JSX.Element {
  // Select only this tab's status entry (shallow-compared) so an unrelated
  // pane's status tick doesn't re-render this view or re-run the resolution.
  const agentStatusEntry = useAppStore(
    useShallow((s) =>
      preferredPaneKey
        ? s.agentStatusByPaneKey[preferredPaneKey]
        : findTabAgentEntry(s.agentStatusByPaneKey, terminalTabId)
    )
  )

  const resolution = useMemo(() => {
    // paneKey: prefer the live entry's key; fall back to the tab id so the hook
    // still has a stable key to select live status by before any pane reports.
    const paneKey = preferredPaneKey ?? agentStatusEntry?.paneKey ?? `${terminalTabId}:`
    return resolveNativeChatSession({
      paneKey,
      launchAgent,
      ...(agentStatusEntry ? { agentStatusEntry } : {}),
      ptyId: targetPtyId
    })
  }, [agentStatusEntry, terminalTabId, preferredPaneKey, targetPtyId, launchAgent])

  if (!resolution) {
    return <NativeChatEmptyState kind="not-agent" />
  }

  return (
    <NativeChatResolvedView
      paneKey={resolution.paneKey}
      agent={resolution.agent}
      sessionId={resolution.sessionId}
      transcriptPath={resolution.transcriptPath}
      targetPtyId={targetPtyId}
      terminalTabId={terminalTabId}
      onSwitchToTerminal={onSwitchToTerminal}
      contextMenuActions={contextMenuActions}
    />
  )
}

function NativeChatResolvedView({
  paneKey,
  agent,
  sessionId,
  transcriptPath,
  targetPtyId,
  terminalTabId,
  onSwitchToTerminal,
  contextMenuActions
}: {
  paneKey: string
  agent: NativeChatSession['agent']
  sessionId: string | null
  transcriptPath: string | null
  targetPtyId: string | null
  terminalTabId: string
  onSwitchToTerminal?: () => void
  contextMenuActions?: Omit<NativeChatContextMenuActions, 'onPaste'>
}): React.JSX.Element {
  const session = useNativeChatLiveSession({ paneKey, agent, sessionId, transcriptPath })
  // Live hook state for this pane, selected directly so the working indicator
  // flips the instant the agent reports 'working' — even when switching to chat
  // mid-turn before the transcript merge has caught up.
  const hookWorking = useAppStore((s) => s.agentStatusByPaneKey[paneKey]?.state === 'working')
  // The agent's in-progress reply preview (hook), shown as a live streaming
  // bubble while it works — before the completed turn flushes to the transcript.
  const hookPreview = useAppStore((s) => s.agentStatusByPaneKey[paneKey]?.lastAssistantMessage)
  const canSend = useNativeChatCanSend(targetPtyId)
  // Reuse the verified composer send path for interactive cards and composer
  // stop (Stop sends ESC, the agent-TUI interrupt key).
  const interactiveSend = useNativeChatInteractiveSend(terminalTabId, targetPtyId, agent)
  const [workingInterrupted, setWorkingInterrupted] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<NativeChatComposerHandle>(null)
  const isMac = useMemo(() => isMacPlatform(), [])
  const pasteClipboardIntoComposer = useCallback(() => {
    void window.api.ui
      .readClipboardText({ maxBytes: NATIVE_CHAT_CONTEXT_PASTE_MAX_BYTES })
      .then((text) => {
        if (text.length > 0) {
          composerRef.current?.insertTypedText(text)
        }
      })
      .catch(() => {})
  }, [])
  const contextMenu = useNativeChatContextMenu({
    rootRef,
    onSwitchToTerminal,
    actions: {
      onPaste: pasteClipboardIntoComposer,
      ...(contextMenuActions ?? emptyNativeChatContextMenuActions)
    }
  })

  useEffect(() => {
    const root = rootRef.current
    if (!root) {
      return
    }
    const onKeyPaste = (event: KeyboardEvent): void => {
      if (
        !matchesNativeChatPasteShortcut(event, isMac) ||
        !shouldFocusNativeChatPaneFromPointerTarget(event.target)
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      pasteClipboardIntoComposer()
    }

    root.addEventListener('keydown', onKeyPaste, { capture: true })
    return () => {
      root.removeEventListener('keydown', onKeyPaste, { capture: true })
    }
  }, [isMac, pasteClipboardIntoComposer])

  useEffect(() => {
    const onAppMenuPaste = (event: Event): void => {
      const root = rootRef.current
      const activeElement = document.activeElement
      if (
        !root ||
        !(activeElement instanceof Element) ||
        !root.contains(activeElement) ||
        !shouldFocusNativeChatPaneFromPointerTarget(activeElement)
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      pasteClipboardIntoComposer()
    }

    window.addEventListener(APP_MENU_PASTE_EVENT, onAppMenuPaste)
    return () => {
      window.removeEventListener(APP_MENU_PASTE_EVENT, onAppMenuPaste)
    }
  }, [pasteClipboardIntoComposer])

  // Optimistic "queued" sends (mobile parity): a composer send is echoed
  // immediately and pruned once its real user turn lands in the transcript, so
  // the message never vanishes between send and transcript catch-up.
  const commandMarkerScope = useMemo(
    () => ({ paneKey, agent, sessionId }),
    [paneKey, agent, sessionId]
  )
  const pendingScope = useMemo(() => ({ paneKey, agent }), [paneKey, agent])
  const [pending, setPending] = useState<NativeChatPendingSend[]>(() =>
    readPendingSendCache(pendingScope)
  )
  const pendingCounter = useRef(0)
  // Slash commands aren't chat turns, so they get a small local "Ran /clear"
  // system line instead of a user bubble. Capped + cached per conversation.
  const [commandMarkers, setCommandMarkers] = useState<NativeChatCommandMarker[]>(() =>
    readCommandMarkerCache(commandMarkerScope)
  )
  // Reset the optimistic queue only when the pane/agent changes. A fresh launch
  // often learns its provider session id after the first send; clearing pending
  // on that transition briefly flashes the empty state before the transcript
  // user turn lands.
  useEffect(() => {
    setPending(readPendingSendCache(pendingScope))
    setWorkingInterrupted(false)
  }, [pendingScope])
  // Command markers are session-scoped because slash commands like /clear are
  // local feedback for a specific transcript boundary.
  useEffect(() => {
    setCommandMarkers(readCommandMarkerCache(commandMarkerScope))
    setWorkingInterrupted(false)
  }, [commandMarkerScope])
  // Prune echoes whose real user turn is now in the transcript.
  useEffect(() => {
    setPending((prev) =>
      writePendingSendCache(pendingScope, prunePendingSends(prev, session.messages))
    )
  }, [session.messages, pendingScope])
  const onOptimisticSend = useCallback(
    (text: string, imagePaths?: string[]) => {
      setWorkingInterrupted(false)
      pendingCounter.current += 1
      const entry: NativeChatPendingSend = {
        id: `${pendingCounter.current}`,
        text,
        sentAt: Date.now(),
        ...(imagePaths ? { imagePaths } : {})
      }
      setPending(appendPendingSendCache(pendingScope, entry))
    },
    [pendingScope]
  )
  const onSlashCommand = useCallback(
    (command: string) => {
      setCommandMarkers(appendCommandMarkerCache(commandMarkerScope, command))
    },
    [commandMarkerScope]
  )

  const sessionAfterCommandBoundaries = useMemo<typeof session>(() => {
    const messages = applyCommandMarkerBoundaries(session.messages, commandMarkers)
    return messages === session.messages ? session : { ...session, messages }
  }, [session, commandMarkers])

  // The streaming preview bubble (if any) sits after the transcript but before
  // the optimistic user echoes — same order mobile uses.
  const streamingText = useMemo(
    () =>
      deriveNativeChatStreamingText({
        messages: sessionAfterCommandBoundaries.messages,
        previewText: hookPreview,
        working: hookWorking
      }),
    [sessionAfterCommandBoundaries.messages, hookPreview, hookWorking]
  )
  const sessionWithPending = useMemo<typeof session>(() => {
    if (pending.length === 0 && commandMarkers.length === 0 && !streamingText) {
      return sessionAfterCommandBoundaries
    }
    return {
      ...sessionAfterCommandBoundaries,
      messages: [
        ...sessionAfterCommandBoundaries.messages,
        ...commandMarkersAsMessages(commandMarkers),
        ...(streamingText ? [nativeChatStreamingMessage(streamingText)] : []),
        ...pendingSendsAsMessages(pending, sessionAfterCommandBoundaries.messages)
      ]
    }
  }, [sessionAfterCommandBoundaries, pending, commandMarkers, streamingText])
  // Derive the view state from the pending-augmented session so a send into an
  // otherwise-empty conversation flips to the list (showing the queued bubble)
  // instead of staying on the empty state.
  const viewState = selectNativeChatViewState(sessionWithPending)

  const isConversation = viewState.kind === 'ready'
  // Drive "working" from the live hook state too: when toggling to chat while the
  // agent is mid-turn, the merged transcript may not yet reflect the in-flight
  // turn, but the hook already says 'working' — show the indicator immediately.
  const viewWorking = viewState.kind === 'ready' && viewState.isWorking
  useEffect(() => {
    if (shouldClearNativeChatWorkingSuppression({ viewWorking, hookWorking })) {
      setWorkingInterrupted(false)
    }
  }, [viewWorking, hookWorking])
  const isWorking = shouldShowNativeChatWorking({
    isConversation,
    viewWorking,
    hookWorking,
    interrupted: workingInterrupted
  })

  const stopAgent = useCallback(() => {
    setWorkingInterrupted(true)
    interactiveSend.cancel()
  }, [interactiveSend])

  // Chat-only font zoom via Cmd/Ctrl +/-/0, gated to the live conversation so
  // the chord is inert on the loading/empty/error states and elsewhere.
  const fontScale = useNativeChatFontScale(isConversation)

  return (
    <div
      ref={rootRef}
      data-native-chat-root="true"
      tabIndex={-1}
      onPointerDownCapture={(event) => {
        if (event.button === 2) {
          contextMenu.onSelectionCapture()
          event.preventDefault()
          event.stopPropagation()
          return
        }
        if (event.button === 0 && shouldFocusNativeChatPaneFromPointerTarget(event.target)) {
          rootRef.current?.focus({ preventScroll: true })
        }
      }}
      onKeyDownCapture={(event) => {
        if (!shouldRedirectNativeChatTyping(event)) {
          return
        }
        if (!composerRef.current?.insertTypedText(event.key)) {
          return
        }
        event.preventDefault()
        event.stopPropagation()
      }}
      onMouseUpCapture={contextMenu.onSelectionCapture}
      onKeyUpCapture={contextMenu.onSelectionCapture}
      onContextMenuCapture={contextMenu.onContextMenuCapture}
      className="flex h-full min-h-0 w-full flex-col bg-background focus:outline-none"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {viewState.kind === 'loading' ? (
          <NativeChatEmptyState kind="loading" />
        ) : viewState.kind === 'error' ? (
          <NativeChatEmptyState kind="error" message={viewState.message} />
        ) : viewState.kind === 'empty' ? (
          <NativeChatEmptyState kind="empty" agent={agent} />
        ) : (
          <NativeChatMessageList
            session={sessionWithPending}
            isWorking={isWorking}
            expandSignal={false}
            fontScale={fontScale.scale}
          />
        )}
      </div>
      {/* Live interactive cards (question / approval) render just above the
          composer while the agent's interactivePrompt is present (mobile parity). */}
      <NativeChatInteractiveCard paneKey={paneKey} send={interactiveSend} canSend={canSend} />
      {/* canSend reflects the mobile presence-lock: when a mobile client holds
          the pty, the composer shows its guarded state instead of racing the
          mobile driver (R8). */}
      <NativeChatComposer
        ref={composerRef}
        terminalTabId={terminalTabId}
        targetPtyId={targetPtyId}
        agent={agent}
        canSend={canSend}
        isWorking={isWorking}
        onStop={stopAgent}
        onOptimisticSend={onOptimisticSend}
        onSlashCommand={onSlashCommand}
      />
      {contextMenu.menu}
    </div>
  )
}

function matchesNativeChatPasteShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  isMac: boolean
): boolean {
  if (event.altKey || event.shiftKey || event.key.toLowerCase() !== 'v') {
    return false
  }
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}
