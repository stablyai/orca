// Composes the RPC chat ownership state (published by the TerminalPane-
// anchored use-omp-rpc-chat-pane-ownership.ts) with the wave-1 overlay/status
// projections (omp-rpc-turn-reducer.ts) into the exact set of values
// NativeChatView needs, so the view itself stays a thin, pure, remountable
// subscriber — it owns none of the acquire/hold/release lifecycle and
// performs no IPC of its own; every send/abort/respondExtensionUi call
// re-reads current ownership from the store and goes straight through the
// paneKey-scoped store actions (mirroring the existing agentStatusByPaneKey
// pattern: the component that renders the state is not the component that
// owns its lifecycle). Kept separate from the store slice so the
// merge/exclusivity rules below — "never both" (hook preview vs. RPC
// overlay) and "status only when active" (D5) — are unit-testable without
// touching the store.

import { useEffect, useMemo } from 'react'
import { useAppStore } from '../../store'
import type { OmpRpcChatPaneConsumedFailure } from '../../store/slices/omp-rpc-chat-pane-failure-notice'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type {
  OmpRpcChatSendResult,
  OmpRpcChatSendBehavior
} from '../../../../shared/omp-rpc-chat-ipc-contract'
import type {
  OmpRpcExtensionUiRequestFrame,
  OmpRpcExtensionUiResponse,
  OmpRpcSlashCommand
} from '../../../../shared/omp-rpc-protocol'
import type { NativeChatTranscriptWindow } from './native-chat-pagination'
import { ompRpcExecutableCommands, type OmpRpcExecutableCommands } from './omp-rpc-command-catalog'
import { isOmpRpcTurnActive, type OmpRpcSessionConfig } from './omp-rpc-turn-reducer'
import {
  selectOmpRpcOverlayMessages,
  selectOmpRpcRetirableAdvisorTurnIds
} from './omp-rpc-turn-overlay'

export type UseNativeChatOmpRpcIntegrationArgs = {
  paneKey: string
  transcriptMessages: readonly NativeChatMessage[]
  /** What `transcriptMessages` proves about older history. Required, not
   *  optional: the advisor horizon rule below is unsound without it (SA-007),
   *  and a caller that forgot it would silently reintroduce the SA-005 bug. */
  transcriptWindow: NativeChatTranscriptWindow
  /** The hook-preview bubble's raw source text, before RPC exclusivity. */
  hookPreview: string | null | undefined
}

export type NativeChatOmpRpcIntegration = {
  isRpcOwned: boolean
  /** Whether the RPC session's current turn is actively streaming. */
  isRpcTurnWorking: boolean
  /** Spliced into the message list at the streaming bubble's position. */
  overlayMessages: NativeChatMessage[]
  /** `session.status` override for D5 — 'working' only while the RPC turn is
   *  in flight; null leaves the transcript/hook-derived status untouched. */
  statusOverride: 'working' | null
  /** `hookPreview` forced to null while RPC owns the pane, so the hook-preview
   *  bubble and the RPC overlay can never render at the same time. */
  effectiveHookPreview: string | null | undefined
  pendingExtensionUiRequest: OmpRpcExtensionUiRequestFrame | null
  answerExtensionUi: (response: OmpRpcExtensionUiResponse) => void
  sendChat: (args: {
    message: string
    behavior: OmpRpcChatSendBehavior
    /** Wire `id` a command run is correlated under. */
    requestId?: string
    /** Fails the send closed when the pane has rebound since it was queued. */
    expectedGeneration?: number
    /** Run only once the store's own gates admit the send, so a refused
     *  command never claims the shared command-output capture slot. */
    onAuthorized?: () => void
  }) => Promise<OmpRpcChatSendResult>
  abortChat: () => Promise<OmpRpcChatSendResult>
  /** Retires the previous slash command's captured output before the next
   *  one's `command_output` frames arrive on this pane's subscription, and
   *  gives that run the id its later report must match. */
  onCommandDispatched: (commandRunId: string) => void
  /** Records that the dispatched command started a real agent turn, so its
   *  captured output is not also rendered as a system row. Dropped when the
   *  run or the owning session has since been superseded. */
  onCommandAgentInvoked: (commandRunId: string) => void
  /** `expectedGeneration` is the generation the command was dispatched on, so
   *  a replacement session on the same paneKey never shows its notice. */
  reportCommandFailure: (command: string, expectedGeneration?: number) => void
  /** The same durable notice for a plain chat send, which has no command name.
   *  `expectedGeneration` is the generation the message was sent on. */
  reportMessageFailure: (expectedGeneration?: number) => void
  commandFailureMessage: string | null
  /** True when that notice belongs to a session the pane has already replaced,
   *  so a composer already showing a live one can rank the two. */
  commandFailureSuperseded: boolean
  /** Which occurrence the notice is, so the consumer can name it back and can
   *  see a repeat failure whose wording is identical. Null when none pends. */
  commandFailureId: number | null
  /** Clears the pane's notice, naming the one that was read so a newer
   *  failure reported in between is not erased unread. */
  clearCommandFailure: (consumed: OmpRpcChatPaneConsumedFailure) => void
  /** Identifies the RPC session currently bound to this pane. An asynchronous
   *  completion carries the value it started with and is discarded when the
   *  pane has rebound since. */
  sessionGeneration: number
  /** Stable pane-plus-generation identity for a command queue that must
   *  survive remounts while this session remains owned. */
  commandQueueKey: string
  /** OMP's published RPC catalog reduced to what the session route is allowed
   *  to send. Null until this session publishes a catalog. */
  rpcExecutableCommands: OmpRpcExecutableCommands | null
  /** The same catalog unreduced, for the composer's `/` menu — it needs the
   *  descriptions and input hints the name set drops. Null until published. */
  rpcCommands: readonly OmpRpcSlashCommand[] | null
  /** Live session title / model / thinking level, published by OMP's
   *  `session_info_update` and `config_update` side channels — the only source
   *  for them on an RPC-owned pane, whose TUI is gone. */
  sessionTitle: string | null
  sessionConfig: OmpRpcSessionConfig | null
}

/** Stable identity so the retirement effect does not re-run on every render
 *  of a pane that has no advisor card. */
const NO_RETIRABLE_ADVISOR_TURN_IDS: string[] = []

export function useNativeChatOmpRpcIntegration(
  args: UseNativeChatOmpRpcIntegrationArgs
): NativeChatOmpRpcIntegration {
  const { paneKey } = args
  const entry = useAppStore((s) => s.ompRpcChatOwnershipByPaneKey[paneKey])
  const sendOmpRpcChatPane = useAppStore((s) => s.sendOmpRpcChatPane)
  const abortOmpRpcChatPane = useAppStore((s) => s.abortOmpRpcChatPane)
  const respondOmpRpcChatExtensionUi = useAppStore((s) => s.respondOmpRpcChatExtensionUi)
  const dispatchOmpRpcChatTurnAction = useAppStore((s) => s.dispatchOmpRpcChatTurnAction)
  const reportOmpRpcChatPaneCommandFailure = useAppStore(
    (s) => s.reportOmpRpcChatPaneCommandFailure
  )
  const reportOmpRpcChatPaneMessageFailure = useAppStore(
    (s) => s.reportOmpRpcChatPaneMessageFailure
  )
  const clearOmpRpcChatPaneCommandFailure = useAppStore((s) => s.clearOmpRpcChatPaneCommandFailure)
  const isRpcOwned = entry?.status === 'acquired'
  const turnState = entry?.turnState
  const sessionGeneration = entry?.generation ?? 0

  const overlayMessages = useMemo(
    () =>
      isRpcOwned && turnState
        ? selectOmpRpcOverlayMessages(turnState, args.transcriptMessages, args.transcriptWindow)
        : [],
    [isRpcOwned, turnState, args.transcriptMessages, args.transcriptWindow]
  )

  // An advisor card is retired, not just hidden, once the transcript accounts
  // for it: the transcript list is a bounded window, so the covering row leaves
  // it and a merely-hidden card would reappear at the tail as fresh advice.
  // This is the one place that sees both the cards and the transcript, so it is
  // the only place the evidence can be consumed — and the consumption runs only
  // while this view is mounted, which is exactly why the selector must also
  // retire a card the window has provably scrolled past (SA-005): a card
  // covered during a Chat->Terminal detour has no covering row left to find by
  // the time the view comes back. That inference needs `transcriptWindow` to
  // say the window really drops older records (SA-007).
  const retirableAdvisorTurnIds = useMemo(
    () =>
      isRpcOwned && turnState
        ? selectOmpRpcRetirableAdvisorTurnIds(
            turnState,
            args.transcriptMessages,
            args.transcriptWindow
          )
        : NO_RETIRABLE_ADVISOR_TURN_IDS,
    [isRpcOwned, turnState, args.transcriptMessages, args.transcriptWindow]
  )
  useEffect(() => {
    if (retirableAdvisorTurnIds.length === 0) {
      return
    }
    dispatchOmpRpcChatTurnAction(
      paneKey,
      { type: 'advisor-cards-covered', turnIds: retirableAdvisorTurnIds },
      sessionGeneration
    )
  }, [retirableAdvisorTurnIds, dispatchOmpRpcChatTurnAction, paneKey, sessionGeneration])

  const rpcExecutableCommands = useMemo(
    () => (isRpcOwned ? ompRpcExecutableCommands(turnState?.availableCommands) : null),
    [isRpcOwned, turnState?.availableCommands]
  )

  return {
    isRpcOwned,
    isRpcTurnWorking: isRpcOwned && turnState?.status === 'working',
    overlayMessages,
    statusOverride: isRpcOwned && turnState && isOmpRpcTurnActive(turnState) ? 'working' : null,
    effectiveHookPreview: isRpcOwned ? null : args.hookPreview,
    pendingExtensionUiRequest: isRpcOwned ? (turnState?.pendingExtensionUiRequest ?? null) : null,
    answerExtensionUi: (response) => respondOmpRpcChatExtensionUi(paneKey, response),
    sendChat: (sendArgs) => sendOmpRpcChatPane(paneKey, sendArgs),
    abortChat: () => abortOmpRpcChatPane(paneKey),
    onCommandDispatched: (commandRunId) =>
      dispatchOmpRpcChatTurnAction(
        paneKey,
        { type: 'command-dispatched', commandRunId },
        sessionGeneration
      ),
    onCommandAgentInvoked: (commandRunId) =>
      dispatchOmpRpcChatTurnAction(
        paneKey,
        { type: 'command-agent-invoked', commandRunId },
        sessionGeneration
      ),
    reportCommandFailure: (command, expectedGeneration) =>
      reportOmpRpcChatPaneCommandFailure(paneKey, command, expectedGeneration),
    reportMessageFailure: (expectedGeneration) =>
      reportOmpRpcChatPaneMessageFailure(paneKey, expectedGeneration),
    commandFailureMessage: entry?.commandFailureMessage ?? null,
    commandFailureSuperseded: entry?.commandFailureSuperseded === true,
    commandFailureId: entry?.commandFailureId ?? null,
    clearCommandFailure: (consumed) => clearOmpRpcChatPaneCommandFailure(paneKey, consumed),
    sessionGeneration,
    commandQueueKey: `${paneKey}:${sessionGeneration}`,
    rpcExecutableCommands,
    rpcCommands: isRpcOwned ? (turnState?.availableCommands ?? null) : null,
    sessionTitle: isRpcOwned ? (turnState?.sessionInfo?.title ?? null) : null,
    sessionConfig: isRpcOwned ? (turnState?.config ?? null) : null
  }
}
