// Renderer-owned, paneKey-scoped publication of OMP RPC chat ownership
// (Decision 1). Written exclusively by the acquire/hold hook mounted at
// TerminalPane — use-omp-rpc-chat-pane-ownership.ts — which anchors
// ownership to the pane's life, not a Chat-view mount. NativeChatView reads
// this slice as a pure remountable subscriber, mirroring the existing
// agentStatusByPaneKey pattern: the component that renders the state is not
// the component that owns its lifecycle.
//
// send/abort/respondExtensionUi are plain paneKey-scoped actions here, not
// callbacks returned by a hook instance — a remounted NativeChatView has no
// live reference to the TerminalPane-anchored hook's closure, and none is
// needed: every call re-reads the current status from this slice and goes
// straight to the IPC surface (window.api.ompRpcChat), exactly as the former
// hook-returned callbacks did.

import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import {
  describeOmpRpcCommandFailure,
  describeOmpRpcMessageFailure,
  withPaneFailureCleared,
  withPaneFailureMessage,
  type OmpRpcChatPaneConsumedFailure
} from './omp-rpc-chat-pane-failure-notice'
import type {
  OmpRpcChatAcquireFailureReason,
  OmpRpcChatSendBehavior,
  OmpRpcChatSendResult
} from '../../../../shared/omp-rpc-chat-ipc-contract'
import type {
  OmpRpcExtensionUiResponse,
  OmpRpcImageContent
} from '../../../../shared/omp-rpc-protocol'
import {
  isOmpRpcExecutableCommand,
  ompRpcExecutableCommands
} from '../../components/native-chat/omp-rpc-command-catalog'
import {
  createInitialOmpRpcTurnState,
  ompRpcTurnReducer,
  type OmpRpcTurnAction,
  type OmpRpcTurnState
} from '../../components/native-chat/omp-rpc-turn-reducer'

export type OmpRpcChatPaneOwnershipStatus =
  | 'idle'
  | 'preparing'
  | 'pending'
  | 'acquired'
  // Why (F3): the RPC child exited or protocol-faulted mid-turn — a terminal
  // failure distinct from 'acquired' so `isOwned` flips false and sends fall
  // back to PTY (D1), instead of staying stuck claiming a dead session.
  | 'faulted'
  | OmpRpcChatAcquireFailureReason

export type OmpRpcChatPaneOwnershipEntry = {
  status: OmpRpcChatPaneOwnershipStatus
  turnState: OmpRpcTurnState
  /** Bumped on every transition INTO 'acquired', so an asynchronous completion
   *  can prove it still belongs to the session that started it. paneKey alone
   *  is not enough: a pane rebinds to a new RPC session while keeping its key,
   *  and a stale callback would then write into the new session's state. */
  generation: number
  /** A draft — a slash command or a plain message — was claimed by a Chat
   *  surface that unmounted before its send was rejected. Pane-scoped so the
   *  replacement surface can show what the discarded local notice could not. */
  commandFailureMessage?: string | null
  /** Whether the notice above describes a send from a session this pane has
   *  since replaced. The store cannot rank it on its own: a mounted composer
   *  keeps its live failure in local state, leaving this field free, so the
   *  attribution has to travel with the notice and be applied where the live
   *  notice actually lives (use-native-chat-composer-command-failure-notice). */
  commandFailureSuperseded?: boolean
  /** Which occurrence the notice above is. A consumer names it back to clear,
   *  so a second failure that reads identically -- same wording, same flag --
   *  is not swept away with the first, and reaches the composer as a change it
   *  can actually see. Null whenever no notice is pending. */
  commandFailureId?: number | null
  /** Bug 1 fix (wave 7): the wave-4 resolved OMP session identity (Decision
   *  2's use-omp-pane-session-identity.ts, a bare session id), published so
   *  the transcript-read path (NativeChatView) can use it instead of the
   *  still-broken agent-status hook chain (open item 2), which never
   *  delivers a `providerSession.id` for omp panes. Sticky: once resolved
   *  for a paneKey it is never cleared just because the pane's live ptyId
   *  later changes (e.g. RPC acquisition killing the PTY) — only a genuine
   *  identity rebind or pane/tab close (which drops the whole ownership row
   *  via clearOmpRpcChatPaneOwnership) replaces it. */
  resolvedSessionId: string | null
}

const NOT_OWNED_RESULT: OmpRpcChatSendResult = {
  ok: false,
  reason: 'no RPC-owned session for this pane'
}

const SUPERSEDED_SESSION_RESULT: OmpRpcChatSendResult = {
  ok: false,
  reason: 'the RPC session this send was dispatched into has been replaced'
}

const UNPUBLISHED_COMMAND_RESULT: OmpRpcChatSendResult = {
  ok: false,
  reason: 'the RPC session no longer publishes this command'
}

export type OmpRpcChatPaneOwnershipSlice = {
  ompRpcChatOwnershipByPaneKey: Record<string, OmpRpcChatPaneOwnershipEntry>
  /** Monotonic session epochs survive a row clear, so a queued send cannot
   *  mistake a genuine replacement session for the one it started under. */
  ompRpcChatGenerationByPaneKey: Record<string, number>
  /** Stamps every failure-notice write with a distinct occurrence id. Store-wide
   *  and never reset, so an id is never reused across panes or across a row that
   *  was dropped and rebuilt -- which is what the clear's compare-and-swap
   *  relies on. */
  ompRpcChatFailureNoticeSequence: number
  setOmpRpcChatPaneStatus: (paneKey: string, status: OmpRpcChatPaneOwnershipStatus) => void
  /** Bug 1 fix (wave 7): publishes the wave-4 resolved OMP session identity
   *  (see OmpRpcChatPaneOwnershipEntry.resolvedSessionId) for a paneKey.
   *  A no-op when the value is unchanged. */
  setOmpRpcChatPaneResolvedSessionId: (paneKey: string, sessionId: string) => void
  /** `expectedGeneration` re-words the notice when the pane has since rebound
   *  to a replacement session, which keeps the paneKey but never dispatched
   *  this command: the notice is still delivered — the draft is spent either
   *  way — but it names the rebind so the live session is not blamed.
   *  Omitted only by a caller with no dispatch generation to prove. */
  reportOmpRpcChatPaneCommandFailure: (
    paneKey: string,
    command: string,
    expectedGeneration?: number
  ) => void
  /** Same durable notice for an ordinary chat send, which carries no command
   *  name to quote back. `expectedGeneration` attributes it the same way: a
   *  paneKey outlives the session that sent the message. */
  reportOmpRpcChatPaneMessageFailure: (paneKey: string, expectedGeneration?: number) => void
  /** Clears the notice only while `consumed` names the occurrence still on the
   *  row. A consumer reads the notice at render and clears it from a passive
   *  effect a tick later; another in-flight send can report in between, and
   *  clearing the row blind -- or by wording, which repeat failures share --
   *  would erase a notice nobody has seen. */
  clearOmpRpcChatPaneCommandFailure: (
    paneKey: string,
    consumed: OmpRpcChatPaneConsumedFailure
  ) => void
  /** Applies one turn-lifecycle action to the paneKey's turn state, creating
   *  an idle entry first if none exists yet (a frame can arrive the same
   *  tick ownership is first published). `expectedGeneration` drops the action
   *  when the pane has since rebound to a different RPC session. */
  dispatchOmpRpcChatTurnAction: (
    paneKey: string,
    action: OmpRpcTurnAction,
    expectedGeneration?: number
  ) => void
  /** Drops the pane's ownership row entirely. Called by the owning hook's
   *  effect cleanup on every run's end — pane/tab close, identity rebind, or
   *  app quit — never a bare Terminal<->Chat toggle. */
  clearOmpRpcChatPaneOwnership: (paneKey: string) => void
  sendOmpRpcChatPane: (
    paneKey: string,
    args: {
      message: string
      images?: OmpRpcImageContent[]
      behavior: OmpRpcChatSendBehavior
      /** Wire `id` for a command run, so its later prompt_result is attributable. */
      requestId?: string
      /** The generation the caller believes it is sending into. Dropped when
       *  the pane has since rebound. A queued command's only live check: the
       *  Chat-view hook that dispatched it may be unmounted by the time it
       *  runs, leaving its own generation ref frozen at the old value. */
      expectedGeneration?: number
      /** Run synchronously once every gate below admits the send, and never
       *  otherwise — the hook that dispatched a queued command cannot decide
       *  this for itself, so anything it would lose on a refusal (the shared
       *  `command_output` capture slot) is claimed from here instead. Never
       *  forwarded to IPC. */
      onAuthorized?: () => void
    }
  ) => Promise<OmpRpcChatSendResult>
  abortOmpRpcChatPane: (paneKey: string) => Promise<OmpRpcChatSendResult>
  respondOmpRpcChatExtensionUi: (paneKey: string, response: OmpRpcExtensionUiResponse) => void
}

export const createOmpRpcChatPaneOwnershipSlice: StateCreator<
  AppState,
  [],
  [],
  OmpRpcChatPaneOwnershipSlice
> = (set, get) => ({
  ompRpcChatOwnershipByPaneKey: {},
  ompRpcChatGenerationByPaneKey: {},
  ompRpcChatFailureNoticeSequence: 0,
  setOmpRpcChatPaneStatus: (paneKey, status) => {
    set((s) => {
      const current = s.ompRpcChatOwnershipByPaneKey[paneKey]
      if (current?.status === status) {
        return s
      }
      const previousGeneration = Math.max(
        current?.generation ?? 0,
        s.ompRpcChatGenerationByPaneKey[paneKey] ?? 0
      )
      const generation = status === 'acquired' ? previousGeneration + 1 : previousGeneration
      return {
        ompRpcChatOwnershipByPaneKey: {
          ...s.ompRpcChatOwnershipByPaneKey,
          [paneKey]: {
            status,
            turnState: current?.turnState ?? createInitialOmpRpcTurnState(),
            generation,
            commandFailureMessage: current?.commandFailureMessage ?? null,
            commandFailureSuperseded: current?.commandFailureSuperseded ?? false,
            commandFailureId: current?.commandFailureId ?? null,
            resolvedSessionId: current?.resolvedSessionId ?? null
          }
        },
        ompRpcChatGenerationByPaneKey: {
          ...s.ompRpcChatGenerationByPaneKey,
          [paneKey]: generation
        }
      }
    })
  },
  setOmpRpcChatPaneResolvedSessionId: (paneKey, sessionId) => {
    set((s) => {
      const current = s.ompRpcChatOwnershipByPaneKey[paneKey]
      if (current?.resolvedSessionId === sessionId) {
        return s
      }
      return {
        ompRpcChatOwnershipByPaneKey: {
          ...s.ompRpcChatOwnershipByPaneKey,
          [paneKey]: {
            status: current?.status ?? 'idle',
            turnState: ompRpcTurnReducer(
              current?.turnState ?? createInitialOmpRpcTurnState(),
              { type: 'session-identity-bound', sessionId }
            ),
            generation: current?.generation ?? s.ompRpcChatGenerationByPaneKey[paneKey] ?? 0,
            commandFailureMessage: current?.commandFailureMessage ?? null,
            commandFailureSuperseded: current?.commandFailureSuperseded ?? false,
            commandFailureId: current?.commandFailureId ?? null,
            resolvedSessionId: sessionId
          }
        }
      }
    })
  },
  reportOmpRpcChatPaneCommandFailure: (paneKey, command, expectedGeneration) => {
    set((s) =>
      withPaneFailureMessage(
        s,
        paneKey,
        (superseded) => describeOmpRpcCommandFailure(command, superseded),
        expectedGeneration
      )
    )
  },
  reportOmpRpcChatPaneMessageFailure: (paneKey, expectedGeneration) => {
    set((s) => withPaneFailureMessage(s, paneKey, describeOmpRpcMessageFailure, expectedGeneration))
  },
  clearOmpRpcChatPaneCommandFailure: (paneKey, consumed) => {
    set((s) => withPaneFailureCleared(s, paneKey, consumed))
  },
  dispatchOmpRpcChatTurnAction: (paneKey, action, expectedGeneration) => {
    set((s) => {
      const current = s.ompRpcChatOwnershipByPaneKey[paneKey]
      // Why: a completion from a superseded session must not write into the
      // session that replaced it on this same paneKey.
      if (expectedGeneration !== undefined && (current?.generation ?? 0) !== expectedGeneration) {
        return s
      }
      const turnState = ompRpcTurnReducer(
        current?.turnState ?? createInitialOmpRpcTurnState(),
        action
      )
      return {
        ompRpcChatOwnershipByPaneKey: {
          ...s.ompRpcChatOwnershipByPaneKey,
          [paneKey]: {
            status: current?.status ?? 'idle',
            turnState,
            generation: current?.generation ?? s.ompRpcChatGenerationByPaneKey[paneKey] ?? 0,
            commandFailureMessage: current?.commandFailureMessage ?? null,
            commandFailureSuperseded: current?.commandFailureSuperseded ?? false,
            commandFailureId: current?.commandFailureId ?? null,
            resolvedSessionId: current?.resolvedSessionId ?? null
          }
        }
      }
    })
  },
  clearOmpRpcChatPaneOwnership: (paneKey) => {
    set((s) => {
      if (!(paneKey in s.ompRpcChatOwnershipByPaneKey)) {
        return s
      }
      const next = { ...s.ompRpcChatOwnershipByPaneKey }
      delete next[paneKey]
      return { ompRpcChatOwnershipByPaneKey: next }
    })
  },
  sendOmpRpcChatPane: (paneKey, args) => {
    const api = window.api?.ompRpcChat
    const entry = get().ompRpcChatOwnershipByPaneKey[paneKey]
    if (entry?.status !== 'acquired' || !api) {
      return Promise.resolve(NOT_OWNED_RESULT)
    }
    const { expectedGeneration, onAuthorized, ...sendArgs } = args
    if (expectedGeneration !== undefined && entry.generation !== expectedGeneration) {
      return Promise.resolve(SUPERSEDED_SESSION_RESULT)
    }
    // Why: `available_commands_update` republishes the catalog without bumping
    // the generation, so a command proven executable when it was claimed can be
    // unproven by the time it dequeues. OMP hands anything its lookup misses to
    // the model as a prompt, so the proof is rechecked here against the live
    // catalog — the dispatching hook's own recheck freezes when its Chat
    // surface unmounts, which a queued command outlives.
    if (
      sendArgs.behavior === 'command' &&
      !isOmpRpcExecutableCommand(
        sendArgs.message,
        ompRpcExecutableCommands(entry.turnState.availableCommands)
      )
    ) {
      return Promise.resolve(UNPUBLISHED_COMMAND_RESULT)
    }
    // Every gate has passed, so this send is the one that will reach the wire:
    // whatever the caller must claim before its uncorrelated response frames
    // arrive is claimed now, in this same tick, and only now.
    onAuthorized?.()
    return api.send({ paneKey, ...sendArgs })
  },
  abortOmpRpcChatPane: (paneKey) => {
    const api = window.api?.ompRpcChat
    if (get().ompRpcChatOwnershipByPaneKey[paneKey]?.status !== 'acquired' || !api) {
      return Promise.resolve(NOT_OWNED_RESULT)
    }
    return api.abort({ paneKey })
  },
  respondOmpRpcChatExtensionUi: (paneKey, response) => {
    // Dispatch unconditionally: the reducer's dismiss is a local UI concern
    // independent of whether the IPC round trip below can still land.
    get().dispatchOmpRpcChatTurnAction(paneKey, {
      type: 'extension-ui-answered',
      requestId: response.id
    })
    // Why (F7): fire-and-forget, but a rejected IPC round trip must not
    // become an unhandled promise rejection.
    void window.api?.ompRpcChat?.respondExtensionUi({ paneKey, response })?.catch(() => {})
  }
})
