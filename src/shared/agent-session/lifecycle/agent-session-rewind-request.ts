import type * as React from 'react'
import {
  AGENT_SESSION_REWIND_REASONS,
  type AgentSessionRewindReason,
  type AgentSessionRewindResult,
  type AgentSessionRewindSupport
} from './agent-session-rewind'
import {
  agentSessionRewindContextFloor,
  agentSessionRewindTargetIds
} from './agent-session-rewind-targets'
import type { AgentSessionWriteFailure } from '../failures/agent-session-write-failure'
import type { StructuredAgentSessionState } from '../structured-agent-session-reducer'
import type { AgentJournalMessageItem } from '../journal/agent-session-journal-types'
import { nativeChatRewindOffered } from '../../native-chat/native-chat-rewind-eligibility'
import type { AgentJournalCursor } from '../journal/agent-session-journal-identity'

/** How long a confirmed rewind waits for its new conversation before letting go. */
export const AGENT_SESSION_REWIND_RESET_TIMEOUT_MS = 120_000

/** Each sentence a rewind can show; every client words them in its own language. */
export type AgentSessionRewindNotice =
  | AgentSessionRewindReason
  | 'refused'
  | 'unavailable'
  | 'returned-unknown'
  | 'timeout'
  | 'pending'

export function agentSessionRewindReasonNotice(
  reason: string | undefined
): AgentSessionRewindNotice {
  return AGENT_SESSION_REWIND_REASONS.find((value) => value === reason) ?? 'refused'
}

export type AgentSessionRewindSendOutcome =
  | { kind: 'done'; value: AgentSessionRewindResult }
  | { kind: 'not-done'; failure: AgentSessionWriteFailure }
  /** Unavailable at entry, so nothing was dispatched. */
  | { kind: 'dropped' }

export type AgentSessionRewindInput = {
  sessionId: string
  /** Captures the issuing view visit; the returned check says whether it still shows. */
  capturePresentation: () => () => boolean
  /** Puts the discarded message back after whatever is typed; absent where there is no composer. */
  returnToComposer?: (itemId: string, blocks: AgentJournalMessageItem['blocks']) => void
  /** Called once the discarded message is back in the composer. */
  onMessageReturned?: () => void
  /** Whether the view is shown, and so reading; absent means shown. */
  isVisible?: boolean
  state: StructuredAgentSessionState
  contextFloor?: AgentJournalCursor
  /** Undefined until the host has answered for the current runtime. */
  support: AgentSessionRewindSupport | undefined
  /** The host's in-doubt latch: disables the action, never sending. */
  hostBlockedReason?: AgentSessionRewindReason
  blocked: boolean
  send: (fields: {
    itemId: string
    expectedEpoch: string
  }) => Promise<AgentSessionRewindSendOutcome>
  notify: { error: (text: string) => void; message: (text: string) => void }
}

export type AgentSessionRewindSurface = {
  disabledReason: string | null
  eligibleItemIds: ReadonlySet<string>
  request: (itemId: string, confirm: () => Promise<boolean>) => Promise<void>
}

/** Which rewind check refused; `outcome-unknown` whenever nothing proves the rewind did not run. */
function rewindFailureReason(failure: AgentSessionWriteFailure): string | undefined {
  if (failure.kind === 'unconfirmed') {
    return 'outcome-unknown'
  }
  if (failure.kind === 'failed') {
    return undefined
  }
  if (failure.code === 'agent_session_operation_unknown') {
    return 'outcome-unknown'
  }
  if (failure.code === 'structured_agent_session_unsupported') {
    return 'unsupported'
  }
  return failure.details && 'rewindReason' in failure.details
    ? failure.details.rewindReason
    : undefined
}

function blockedNotice(input: AgentSessionRewindInput): AgentSessionRewindNotice | null {
  if (input.hostBlockedReason) {
    return agentSessionRewindReasonNotice(input.hostBlockedReason)
  }
  if (input.support?.supported === false && !nativeChatRewindOffered(input.support)) {
    return agentSessionRewindReasonNotice(input.support.reason)
  }
  const { state } = input
  if (!input.support || !state.epoch || state.fence === null || state.status !== 'ready') {
    return 'unavailable'
  }
  return input.blocked ? 'busy' : null
}

/** Whether the message went back; read from the state the user confirmed against. */
function returnTargetToComposer(input: AgentSessionRewindInput, itemId: string): boolean {
  const target = input.state.items.find((item) => item.itemId === itemId)
  if (!input.returnToComposer || target?.body.kind !== 'message') {
    return false
  }
  input.returnToComposer(itemId, target.body.blocks)
  return true
}

/** One rewind flow for every client; React and the client's wording come in so mobile and desktop share the rules. */
export function createAgentSessionRewindHook(
  {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState
  }: Pick<
    typeof React,
    'useCallback' | 'useEffect' | 'useLayoutEffect' | 'useMemo' | 'useRef' | 'useState'
  >,
  say: (notice: AgentSessionRewindNotice) => string
) {
  const blockedReason = (input: AgentSessionRewindInput): string | null => {
    const notice = blockedNotice(input)
    return notice ? say(notice) : null
  }
  return function useAgentSessionRewind(input: AgentSessionRewindInput) {
    const active = useRef(false)
    const latest = useRef(input)
    useLayoutEffect(() => {
      latest.current = input
      active.current = true
      return () => {
        active.current = false
      }
    }, [input])
    // Reserve single-flight at the first click; only confirmed sending blocks other actions.
    // Both name their session: one phone view moves between chats, and another chat's rewind holds nothing here.
    const inFlight = useRef<string | null>(null)
    const [sending, setSending] = useState<string | null>(null)
    const [awaiting, setAwaiting] = useState<{
      sessionId: string
      epoch: string
      sequence?: number
      isCurrent: () => boolean
    } | null>(null)
    const awaitingReset =
      awaiting?.sessionId === input.sessionId &&
      awaiting.epoch === input.state.epoch &&
      (awaiting.sequence === undefined || (input.state.cursor?.sequence ?? 0) < awaiting.sequence)
    // Hidden views stop reading; missing reset evidence while hidden is not a failure.
    const hiddenWhileAwaiting = useRef(false)
    const visible = input.isVisible !== false
    useLayoutEffect(() => {
      hiddenWhileAwaiting.current ||= !visible
    }, [visible])
    useEffect(() => {
      if (!awaitingReset) {
        return
      }
      hiddenWhileAwaiting.current = latest.current.isVisible === false
      const timer = setTimeout(() => {
        setAwaiting(null)
        if (!hiddenWhileAwaiting.current && awaiting?.isCurrent()) {
          latest.current.notify.error(say('timeout'))
        }
      }, AGENT_SESSION_REWIND_RESET_TIMEOUT_MS)
      return () => clearTimeout(timer)
    }, [awaiting, awaitingReset])
    const pending = sending === input.sessionId || awaitingReset
    const disabledReason = pending ? say('pending') : blockedReason(input)
    const blockedRef = useRef(false)
    useLayoutEffect(() => {
      blockedRef.current = pending
    }, [pending])

    const request = useCallback(async (itemId: string, confirm: () => Promise<boolean>) => {
      const captured = latest.current
      if (
        inFlight.current === captured.sessionId ||
        blockedRef.current ||
        blockedReason(captured) ||
        !agentSessionRewindTargetIds(
          captured.state,
          agentSessionRewindContextFloor(captured.state, captured.contextFloor)
        ).has(itemId)
      ) {
        return
      }
      const isCurrent = captured.capturePresentation()
      const expectedEpoch = captured.state.epoch!
      inFlight.current = captured.sessionId
      let keepBlocked = false
      try {
        const confirmed = await confirm()
        const current = latest.current
        if (
          !confirmed ||
          !active.current ||
          !isCurrent() ||
          current.sessionId !== captured.sessionId
        ) {
          return
        }
        if (
          current.state.epoch !== expectedEpoch ||
          current.state.cursor?.sequence !== captured.state.cursor?.sequence
        ) {
          current.notify.error(say('stale-epoch'))
          return
        }
        const blocked = blockedReason(current)
        if (blocked) {
          current.notify.error(blocked)
          return
        }
        blockedRef.current = true
        setSending(captured.sessionId)
        const outcome = await current.send({ itemId, expectedEpoch })
        const reason =
          outcome.kind === 'not-done' ? rewindFailureReason(outcome.failure) : undefined
        // Captured content belongs to the conversation even after its view closes.
        const returned =
          (outcome.kind === 'done' || reason === 'outcome-unknown') &&
          returnTargetToComposer(captured, itemId)
        if (!active.current || !isCurrent() || latest.current.sessionId !== captured.sessionId) {
          return
        }
        if (returned) {
          latest.current.onMessageReturned?.()
        }
        const reset = latest.current.state.epoch !== expectedEpoch
        if (outcome.kind === 'done') {
          const caughtUp =
            reset ||
            (outcome.value.sequence !== undefined &&
              (latest.current.state.cursor?.sequence ?? 0) >= outcome.value.sequence)
          keepBlocked = !caughtUp
          setAwaiting(
            caughtUp
              ? null
              : {
                  sessionId: captured.sessionId,
                  epoch: expectedEpoch,
                  isCurrent,
                  ...(outcome.value.sequence !== undefined
                    ? { sequence: outcome.value.sequence }
                    : {})
                }
          )
          return
        }
        if (outcome.kind === 'dropped') {
          return
        }
        if (reset) {
          return
        }
        latest.current.notify.error(
          reason === 'outcome-unknown' && captured.returnToComposer
            ? say('returned-unknown')
            : say(agentSessionRewindReasonNotice(reason))
        )
      } finally {
        if (inFlight.current === captured.sessionId) {
          inFlight.current = null
        }
        if (latest.current.sessionId === captured.sessionId) {
          blockedRef.current = keepBlocked
        }
        setSending((current) => (current === captured.sessionId ? null : current))
      }
    }, [])
    /** Refuse sends during confirmed rewind and explain why. */
    const admitsSend = useCallback((): boolean => {
      if (blockedRef.current) {
        latest.current.notify.message(say('pending'))
      }
      return !blockedRef.current
    }, [])
    const offered = nativeChatRewindOffered(input.support)
    const floor = agentSessionRewindContextFloor(input.state, input.contextFloor)
    const { items, submissions } = input.state
    // Streaming rebuilds items per chunk; keep the set while its ids hold so row actions don't redraw.
    const heldTargets = useRef<ReadonlySet<string>>(new Set())
    const eligibleItemIds = useMemo(() => {
      const next = agentSessionRewindTargetIds({ items, submissions }, floor)
      const held = heldTargets.current
      return next.size === held.size && [...next].every((id) => held.has(id)) ? held : next
    }, [floor, items, submissions])
    useLayoutEffect(() => {
      heldTargets.current = eligibleItemIds
    }, [eligibleItemIds])
    // Memoize row actions and omit them entirely for providers without rewind.
    const surface = useMemo<AgentSessionRewindSurface | undefined>(
      () => (offered ? { disabledReason, request, eligibleItemIds } : undefined),
      [offered, disabledReason, request, eligibleItemIds]
    )
    return { request, admitsSend, surface, disabledReason, pending, blockedRef }
  }
}
