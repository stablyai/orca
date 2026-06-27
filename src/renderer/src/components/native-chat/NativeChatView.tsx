import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import type { TuiAgent } from '../../../../shared/types'
import type { NativeChatSession } from '../../../../shared/native-chat-types'
import { resolveNativeChatSession } from './native-chat-pane-resolution'
import { useNativeChatLiveSession } from './use-native-chat-live-session'
import { selectNativeChatViewState } from './native-chat-view-state'
import { NativeChatMessageList } from './NativeChatMessageList'
import { NativeChatComposer } from './NativeChatComposer'
import { useNativeChatFontScale } from './use-native-chat-font-scale'
import { useNativeChatCanSend } from './use-native-chat-can-send'
import { NativeChatInteractiveCard } from './NativeChatInteractiveCard'
import { NativeChatHeader } from './NativeChatHeader'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import { NativeChatChromeRow } from './NativeChatChromeRow'
import { useNativeChatInteractiveSend } from './use-native-chat-interactive-send'
import { findTabAgentEntry } from './native-chat-tab-agent-entry'
import {
  shouldClearNativeChatWorkingSuppression,
  shouldShowNativeChatWorking
} from './native-chat-working-suppression'
import {
  commandMarkersAsMessages,
  pendingSendsAsMessages,
  prunePendingSends,
  type NativeChatCommandMarker,
  type NativeChatPendingSend
} from './native-chat-pending'
import {
  deriveNativeChatStreamingText,
  nativeChatStreamingMessage
} from '../../../../shared/native-chat-streaming'

export type NativeChatViewProps = {
  /** The terminal tab hosting the agent. paneKey is `${tabId}:${leafId}`. */
  terminalTabId: string
  /** Launch-time agent hint from the TerminalTab, when Orca started one. */
  launchAgent?: TuiAgent | null
}

/**
 * Native chat surface for an agent terminal. Resolves the pane to its agent +
 * session id, streams the assembled conversation via the U4 live-session hook,
 * and renders header, message list, live status, and all empty/loading/error
 * states. When no session id is known yet the hook surfaces live hook state on
 * an empty transcript; a true scrollback-scrape fallback (U6) is wired but only
 * runs when scrollback is obtainable — it degrades to the empty state otherwise.
 */
export default function NativeChatView({
  terminalTabId,
  launchAgent
}: NativeChatViewProps): React.JSX.Element {
  // Select only this tab's status entry (shallow-compared) so an unrelated
  // pane's status tick doesn't re-render this view or re-run the resolution.
  const tabAgentEntry = useAppStore(
    useShallow((s) => findTabAgentEntry(s.agentStatusByPaneKey, terminalTabId))
  )

  const resolution = useMemo(() => {
    // paneKey: prefer the live entry's key; fall back to the tab id so the hook
    // still has a stable key to select live status by before any pane reports.
    const paneKey = tabAgentEntry?.paneKey ?? `${terminalTabId}:`
    return resolveNativeChatSession({
      paneKey,
      launchAgent,
      ...(tabAgentEntry ? { agentStatusEntry: tabAgentEntry } : {}),
      ptyId: null
    })
  }, [tabAgentEntry, terminalTabId, launchAgent])

  if (!resolution) {
    return <NativeChatEmptyState kind="not-agent" />
  }

  return (
    <NativeChatResolvedView
      paneKey={resolution.paneKey}
      agent={resolution.agent}
      sessionId={resolution.sessionId}
      transcriptPath={resolution.transcriptPath}
      terminalTabId={terminalTabId}
    />
  )
}

function NativeChatResolvedView({
  paneKey,
  agent,
  sessionId,
  transcriptPath,
  terminalTabId
}: {
  paneKey: string
  agent: NativeChatSession['agent']
  sessionId: string | null
  transcriptPath: string | null
  terminalTabId: string
}): React.JSX.Element {
  const session = useNativeChatLiveSession({ paneKey, agent, sessionId, transcriptPath })
  // Live hook state for this pane, selected directly so the working indicator
  // flips the instant the agent reports 'working' — even when switching to chat
  // mid-turn before the transcript merge has caught up.
  const hookWorking = useAppStore((s) => s.agentStatusByPaneKey[paneKey]?.state === 'working')
  // The agent's in-progress reply preview (hook), shown as a live streaming
  // bubble while it works — before the completed turn flushes to the transcript.
  const hookPreview = useAppStore((s) => s.agentStatusByPaneKey[paneKey]?.lastAssistantMessage)
  const canSend = useNativeChatCanSend(terminalTabId)
  // Reuse the verified composer send path for interactive cards and composer
  // stop (Stop sends ESC, the agent-TUI interrupt key).
  const interactiveSend = useNativeChatInteractiveSend(terminalTabId, agent)
  // Global expand/collapse for every tool run. Each flip re-syncs all runs; a
  // run can still be toggled individually after.
  const [toolsExpanded, setToolsExpanded] = useState(false)
  const [workingInterrupted, setWorkingInterrupted] = useState(false)

  // Optimistic "queued" sends (mobile parity): a composer send is echoed
  // immediately and pruned once its real user turn lands in the transcript, so
  // the message never vanishes between send and transcript catch-up.
  const [pending, setPending] = useState<NativeChatPendingSend[]>([])
  const pendingCounter = useRef(0)
  // Slash commands aren't chat turns, so they get a small local "Ran /clear"
  // system line instead of a user bubble. Capped + reset per conversation.
  const [commandMarkers, setCommandMarkers] = useState<NativeChatCommandMarker[]>([])
  const commandCounter = useRef(0)
  // Reset the queue when the conversation changes so echoes never cross sessions.
  useEffect(() => {
    setPending([])
    setCommandMarkers([])
    setWorkingInterrupted(false)
  }, [sessionId, agent])
  // Prune echoes whose real user turn is now in the transcript.
  useEffect(() => {
    setPending((prev) => prunePendingSends(prev, session.messages))
  }, [session.messages])
  const onOptimisticSend = useCallback((text: string) => {
    setWorkingInterrupted(false)
    pendingCounter.current += 1
    setPending((prev) => [...prev, { id: `${pendingCounter.current}`, text, sentAt: Date.now() }])
  }, [])
  const onSlashCommand = useCallback((command: string) => {
    commandCounter.current += 1
    // Keep only the most recent few so a long session of commands can't grow it.
    setCommandMarkers((prev) =>
      [...prev, { id: `${commandCounter.current}`, command, sentAt: Date.now() }].slice(-8)
    )
  }, [])

  // The streaming preview bubble (if any) sits after the transcript but before
  // the optimistic user echoes — same order mobile uses.
  const streamingText = useMemo(
    () =>
      deriveNativeChatStreamingText({
        messages: session.messages,
        previewText: hookPreview,
        working: hookWorking
      }),
    [session.messages, hookPreview, hookWorking]
  )
  const sessionWithPending = useMemo<typeof session>(() => {
    if (pending.length === 0 && commandMarkers.length === 0 && !streamingText) {
      return session
    }
    return {
      ...session,
      messages: [
        ...session.messages,
        ...commandMarkersAsMessages(commandMarkers),
        ...(streamingText ? [nativeChatStreamingMessage(streamingText)] : []),
        ...pendingSendsAsMessages(pending)
      ]
    }
  }, [session, pending, commandMarkers, streamingText])
  // Derive the view state from the pending-augmented session so a send into an
  // otherwise-empty conversation flips to the list (showing the queued bubble)
  // instead of staying on the empty state.
  const viewState = selectNativeChatViewState(sessionWithPending)

  // No on-disk session id means the conversation is degraded/approximate: the
  // transcript can't be read, so the banner signals reduced fidelity (R9).
  const isApproximate = sessionId === null
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
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <NativeChatHeader agent={agent} isApproximate={isApproximate} />
      <div className="flex min-h-0 flex-1 flex-col">
        {viewState.kind === 'loading' ? (
          <NativeChatEmptyState kind="loading" />
        ) : viewState.kind === 'error' ? (
          <NativeChatEmptyState kind="error" message={viewState.message} />
        ) : viewState.kind === 'empty' ? (
          <NativeChatEmptyState kind="empty" />
        ) : (
          <NativeChatMessageList
            session={sessionWithPending}
            isWorking={isWorking}
            expandSignal={toolsExpanded}
            fontScale={fontScale.scale}
          />
        )}
      </div>
      {/* Live interactive cards (question / approval) render just above the
          composer while the agent's interactivePrompt is present (mobile parity). */}
      <NativeChatInteractiveCard paneKey={paneKey} send={interactiveSend} canSend={canSend} />
      {/* Chrome row locked to the top of the composer area (mobile parity): the
          working indicator + tool-calls toggle sit above the composer. */}
      {isConversation ? (
        <NativeChatChromeRow
          isWorking={isWorking}
          toolsExpanded={toolsExpanded}
          onToggleTools={() => setToolsExpanded((v) => !v)}
        />
      ) : null}
      {/* canSend reflects the mobile presence-lock: when a mobile client holds
          the pty, the composer shows its guarded state instead of racing the
          mobile driver (R8). */}
      <NativeChatComposer
        terminalTabId={terminalTabId}
        agent={agent}
        canSend={canSend}
        isWorking={isWorking}
        onStop={stopAgent}
        onOptimisticSend={onOptimisticSend}
        onSlashCommand={onSlashCommand}
      />
    </div>
  )
}
