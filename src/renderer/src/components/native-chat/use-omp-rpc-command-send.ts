// Routes a catalog slash command through the RPC session that owns the pane.
// The pane's PTY was killed on acquire (D1), so the keystroke path this command
// used to take no longer exists — without this route the command is simply
// unavailable on a successfully-acquired pane.

import { useCallback, useEffect, useRef } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import { isSlashCommandDraft } from '../../../../shared/native-chat-slash-commands'
import type {
  OmpRpcChatSendBehavior,
  OmpRpcChatSendResult
} from '../../../../shared/omp-rpc-chat-ipc-contract'
import type { NativeChatCommandMarkerOutcome } from './native-chat-command-marker'
import type { OmpRpcExecutableCommands } from './omp-rpc-command-catalog'
import { resolveOmpRpcCommandRoute } from './omp-rpc-local-command-route'

export type UseOmpRpcCommandSendArgs = {
  agent: AgentType
  isRpcOwned: boolean
  /** OMP's published RPC catalog, reduced to dispatch names. Null means the
   *  session has published none, which is not proof this route can run it. */
  executableCommands?: OmpRpcExecutableCommands | null
  /** Identifies the RPC session bound to the pane right now. A completion is
   *  discarded when the pane rebound to another session while it was in
   *  flight — paneKey survives such a rebind, so it cannot scope this. */
  sessionGeneration: number
  /** Stable identity for the pane-owned RPC session. Unlike this remountable
   *  hook, it survives a Chat <-> Terminal toggle. */
  commandQueueKey: string
  sendChat: (args: {
    message: string
    behavior: OmpRpcChatSendBehavior
    /** The wire `id` this prompt is correlated under. */
    requestId?: string
    /** The generation this run was dispatched on. The store drops the send
     *  when the pane has rebound since — the authoritative check, because the
     *  ref below stops tracking rebinds once this hook unmounts. */
    expectedGeneration?: number
    /** Invoked by the store once its own gates admit the send, so the capture
     *  slot below is claimed only for a command that reaches the wire. */
    onAuthorized?: () => void
  }) => Promise<OmpRpcChatSendResult>
  /** Retires the previous command's captured output before this one's frames
   *  arrive, and claims the shared capture slot under `commandRunId`. Handed
   *  to the send as `onAuthorized` rather than called here: this hook's own
   *  gates read refs that freeze at unmount, and a claim made on a command the
   *  store then refuses would erase the PRECEDING command's output. */
  onCommandDispatched?: (commandRunId: string) => void
  onSlashCommand?: (command: string, outcome?: NativeChatCommandMarkerOutcome) => void
  /** The command's own `prompt` response said it started a real agent turn
   *  (e.g. `/retry`). Upstream emits no `prompt_result` frame for a consumed
   *  builtin, so this response flag is the only signal that the captured
   *  command output must not also render as its own row. */
  onCommandAgentInvoked?: (commandRunId: string) => void
  /** The round trip itself failed. There is no PTY to fall back into on an
   *  owned pane, so the caller surfaces it rather than dropping the command. */
  onSendFailed?: () => void
  /** Records a failed command through pane-owned state when this remountable
   *  hook has already unmounted and can no longer show a local notice. The
   *  dispatch generation rides along so the notice cannot land in a
   *  replacement session that took over the same paneKey. */
  onCommandFailed?: (command: string, expectedGeneration: number) => void
}

let commandRunSequence = 0
const commandQueues = new Map<string, Promise<void>>()

function nextCommandRunId(): string {
  commandRunSequence += 1
  return `omp-command-${commandRunSequence}`
}

/** Mirrors useOmpRpcChatSend's claim-the-draft contract: `false` means the
 *  caller must run its normal path unchanged. */
export function useOmpRpcCommandSend(args: UseOmpRpcCommandSendArgs): (text: string) => boolean {
  const {
    agent,
    isRpcOwned,
    executableCommands,
    sessionGeneration,
    commandQueueKey,
    sendChat,
    onCommandDispatched,
    onSlashCommand,
    onCommandAgentInvoked,
    onSendFailed,
    onCommandFailed
  } = args
  // Why: `command_output` frames carry no correlation id (rpc-mode.ts emits
  // them as `{ type, text }`), so two commands in flight at once would pour
  // into one capture slot. This chain makes the previous command's settled
  // response the boundary — the only one the protocol offers for that frame.
  // `prompt_result` needs no such boundary: it echoes the request id, and the
  // run sends its capture-slot id as that request id, so a late report is
  // attributed by id rather than by whoever holds the slot.
  // The live generation, readable from a completion that closed over an older
  // one. Mirrored on every render so a rebind is visible the moment it lands
  // — but only while this hook is mounted, which a queued run can outlive (a
  // Chat <-> Terminal toggle unmounts it). The ref therefore only short-cuts
  // work; `expectedGeneration` on the send is what actually fences the wire.
  const currentGeneration = useRef(sessionGeneration)
  currentGeneration.current = sessionGeneration
  // Mirrored for the same reason and with the same limits as the generation:
  // OMP republishes `available_commands_update` whenever command metadata
  // changes, without a rebind, so a command the catalog proved at claim time
  // can be unproven by the time the queue reaches it. Reading it here only
  // spares a round trip the store would refuse anyway; the store's recheck on
  // the send is what fences the wire — and what admits the capture-slot claim
  // — once this hook has unmounted and this ref has stopped moving.
  const currentExecutableCommands = useRef(executableCommands)
  currentExecutableCommands.current = executableCommands
  const isMounted = useRef(true)
  // Re-armed on setup, not just at declaration: StrictMode replays
  // setup->cleanup->setup on mount, and a flag only cleared by that cleanup
  // would leave a visible composer reporting through the durable route.
  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
    }
  }, [])

  return useCallback(
    (text: string) => {
      const message = text.trim()
      if (
        !message ||
        !isSlashCommandDraft(message) ||
        resolveOmpRpcCommandRoute({ agent, text: message, isRpcOwned, executableCommands }) !==
          'session'
      ) {
        return false
      }
      const dispatchGeneration = currentGeneration.current
      // Every way this run can cost the draft ends here, so the "who can still
      // show this?" decision lives in one place — and mount is the whole test.
      // A run outlives its hook (a Chat <-> Terminal toggle unmounts it, and
      // composer `useState` silently discards a post-unmount write), which is
      // what the durable route exists for. A rebind is NOT such a case: the
      // command's consumed draft and its pane-scoped feedback belong to a pane
      // the user is still looking at, and the durable reporter fences on the
      // dispatch generation, so a superseded report handed to it is discarded
      // rather than redirected. Reporting durably while still mounted would be
      // worse than useless: the composer's notice effect would replay it on
      // remount.
      const reportFailure = (): void => {
        if (isMounted.current) {
          onSendFailed?.()
          return
        }
        onCommandFailed?.(message, dispatchGeneration)
      }
      const run = async (): Promise<void> => {
        if (currentGeneration.current !== dispatchGeneration) {
          // Abandoned while queued behind an earlier command: the pane rebound
          // to another session, so this draft was never sent. It cannot just
          // vanish — the claim above already consumed it and an owned pane has
          // no PTY left to retype it into.
          reportFailure()
          return
        }
        if (
          resolveOmpRpcCommandRoute({
            agent,
            text: message,
            isRpcOwned,
            executableCommands: currentExecutableCommands.current
          }) !== 'session'
        ) {
          // The catalog stopped proving this command while it waited. Sending
          // it anyway would reach OMP's `prompt` with no lookup to resolve it,
          // so the draft the user typed as a command would land as chat text.
          // It is reported rather than dropped: the claim already spent it.
          reportFailure()
          return
        }
        const commandRunId = nextCommandRunId()
        let result: OmpRpcChatSendResult
        try {
          // `command` pins the `prompt` verb: OMP executes builtin and skill
          // slash commands only on `prompt`, while `steer`/`follow_up` hand the
          // text to the model verbatim.
          // `commandRunId` doubles as the wire request id so this run's later
          // `prompt_result` is bound to its capture slot before the frame can
          // arrive — `onAuthorized` claims the slot in this send's own tick.
          // `expectedGeneration` re-checks the dispatch generation against the
          // store, which — unlike the ref above — still sees a rebind that
          // happened after this hook unmounted.
          // `onAuthorized` runs inside that same store gate, so the slot is
          // claimed in the send's own tick and only for a send the store
          // actually admits — the two facts the frame ordering needs.
          result = await sendChat({
            message,
            behavior: 'command',
            requestId: commandRunId,
            expectedGeneration: dispatchGeneration,
            onAuthorized: () => onCommandDispatched?.(commandRunId)
          })
        } catch {
          // Why (F7): a rejected round trip — handler teardown, or a
          // renderer/main lifecycle race — has already cost the draft, so it
          // surfaces as a failure instead of an unhandled rejection. A
          // rejection costs the draft exactly as a declined `{ ok: false }`
          // does, so it reports through the same durable-when-unmounted route.
          reportFailure()
          return
        }
        // A decline is reported before the generation gate: the gate only
        // suppresses a stale session's SUCCESS side effects, and a failure is
        // not one — the draft is already spent, so a rebind landing mid-flight
        // must not swallow the user's only feedback.
        if (!result.ok) {
          reportFailure()
          return
        }
        if (currentGeneration.current !== dispatchGeneration) {
          return
        }
        if (result.agentInvoked) {
          onCommandAgentInvoked?.(commandRunId)
        }
        onSlashCommand?.(message)
      }
      // An idle queue runs inline so the dispatch and its `sendChat` land in
      // the caller's tick, exactly as the unqueued send always did.
      const releaseSlot = (): void => {
        if (commandQueues.get(commandQueueKey) === chain) {
          commandQueues.delete(commandQueueKey)
        }
      }
      // Why both handlers on both links: the completion callbacks are store
      // dispatches, and one that throws must not leave a rejected promise as
      // the queue head — nothing chained off it would ever run, so a single
      // bad dispatch would kill every later slash command on the pane.
      const queued = commandQueues.get(commandQueueKey)
      const chain: Promise<void> = (queued?.then(run, run) ?? run()).then(releaseSlot, releaseSlot)
      commandQueues.set(commandQueueKey, chain)
      return true
    },
    [
      agent,
      isRpcOwned,
      executableCommands,
      commandQueueKey,
      onCommandAgentInvoked,
      onCommandDispatched,
      onCommandFailed,
      onSendFailed,
      onSlashCommand,
      sendChat
    ]
  )
}
