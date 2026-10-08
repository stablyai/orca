import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import type {
  AgentSessionRewindReason,
  AgentSessionRewindResult,
  AgentSessionRewindSupport
} from '../../../../shared/agent-session-rewind'
import type { AgentSessionWriteFailure } from '../../../../shared/agent-session-write-failure'
import type { StructuredAgentSessionState } from '../../../../shared/structured-agent-session-reducer'
import {
  nativeChatRewindPendingCopy,
  nativeChatRewindReasonCopy,
  nativeChatRewindReturnedUnknownCopy,
  nativeChatRewindTimeoutCopy,
  nativeChatRewindUnavailableCopy
} from './native-chat-rewind-copy'
import type {
  StructuredAgentSessionWrite,
  StructuredAgentSessionWriteOutcome
} from './use-structured-agent-session-mutate'
import { returnMessageToComposer } from './structured-agent-session-message-hand-back'
import { nativeChatRewindOffered } from './native-chat-rewind-eligibility'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { useStructuredAgentSessionHostRecoversRewindOnSend } from '@/runtime/structured-agent-session-host-capability'

export type NativeChatRewindSurface = {
  disabledReason: string | null
  request: (itemId: string, confirm: ConfirmationDialogContextValue) => Promise<void>
}

/** How long a confirmed rewind waits for its new conversation before letting go. */
export const NATIVE_CHAT_REWIND_RESET_TIMEOUT_MS = 120_000

type RewindInput = {
  sessionId: string
  /** The composer the discarded message returns to, after whatever is typed there. */
  composerScopeKey?: string
  /** Called once the discarded message is back in the composer. */
  onMessageReturned?: () => void
  /** Whether the pane is shown, and so reading; absent means shown. */
  isVisible?: boolean
  state: StructuredAgentSessionState
  /** Undefined until the host has answered for the current runtime. */
  support: AgentSessionRewindSupport | undefined
  /** The host's in-doubt latch: disables the action, never sending. */
  hostBlockedReason?: AgentSessionRewindReason
  blocked: boolean
  send: (fields: {
    itemId: string
    expectedEpoch: string
  }) => Promise<StructuredAgentSessionWriteOutcome<AgentSessionRewindResult>>
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

function isRewindTarget(state: StructuredAgentSessionState, itemId: string): boolean {
  return state.items.some(
    (item) => item.itemId === itemId && item.body.kind === 'message' && item.body.role === 'user'
  )
}

function blockedReason(input: RewindInput): string | null {
  if (input.hostBlockedReason) {
    return nativeChatRewindReasonCopy(input.hostBlockedReason)
  }
  if (input.support?.supported === false && !nativeChatRewindOffered(input.support)) {
    return nativeChatRewindReasonCopy(input.support.reason)
  }
  const { state } = input
  if (!input.support || !state.epoch || state.fence === null || state.status !== 'ready') {
    return nativeChatRewindUnavailableCopy()
  }
  return input.blocked ? nativeChatRewindReasonCopy('busy') : null
}

/** Whether the message went back; read from the state the user confirmed against. */
function returnTargetToComposer(input: RewindInput, itemId: string): boolean {
  const target = input.state.items.find((item) => item.itemId === itemId)
  if (!input.composerScopeKey || target?.body.kind !== 'message') {
    return false
  }
  returnMessageToComposer(input.composerScopeKey, `rewound-${itemId}`, target.body.blocks)
  return true
}

export function useNativeChatRewind(input: RewindInput) {
  const active = useRef(false)
  useLayoutEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const latest = useRef(input)
  useLayoutEffect(() => {
    latest.current = input
  }, [input])
  // Single-flight from the click on; only `sending` (after Confirm) blocks anything else.
  const inFlight = useRef(false)
  const [sending, setSending] = useState(false)
  // A confirmed rewind whose new conversation has not arrived yet.
  const [awaiting, setAwaiting] = useState<{ sessionId: string; epoch: string } | null>(null)
  const awaitingReset =
    awaiting?.sessionId === input.sessionId && awaiting.epoch === input.state.epoch
  // A hidden pane stops reading, so its new conversation cannot arrive; that is no failure to report.
  const hiddenWhileAwaiting = useRef(false)
  const visible = input.isVisible !== false
  useLayoutEffect(() => {
    if (!visible) {
      hiddenWhileAwaiting.current = true
    }
  }, [visible])
  useEffect(() => {
    if (!awaitingReset) {
      return
    }
    hiddenWhileAwaiting.current = latest.current.isVisible === false
    const timer = setTimeout(() => {
      setAwaiting(null)
      if (!hiddenWhileAwaiting.current) {
        toast.error(nativeChatRewindTimeoutCopy())
      }
    }, NATIVE_CHAT_REWIND_RESET_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [awaitingReset])
  const pending = sending || awaitingReset
  const disabledReason = pending ? nativeChatRewindPendingCopy() : blockedReason(input)
  const blockedRef = useRef(false)
  useLayoutEffect(() => {
    blockedRef.current = pending
  }, [pending])

  const request = useCallback(async (itemId: string, confirm: ConfirmationDialogContextValue) => {
    const captured = latest.current
    if (
      inFlight.current ||
      blockedRef.current ||
      blockedReason(captured) ||
      !isRewindTarget(captured.state, itemId)
    ) {
      return
    }
    const expectedEpoch = captured.state.epoch!
    inFlight.current = true
    let keepBlocked = false
    try {
      const confirmed = await confirm({
        title: translate('components.native-chat.rewind.title', 'Rewind to here?'),
        description: translate(
          'components.native-chat.rewind.confirmation',
          'Discard this message and everything after it? The message returns to the composer so you can edit and resend it. File changes on disk are kept.'
        ),
        confirmLabel: translate('components.native-chat.rewind.confirm', 'Rewind'),
        cancelLabel: translate('components.native-chat.rewind.cancel', 'Cancel'),
        confirmVariant: 'destructive',
        cancelVariant: 'ghost'
      })
      const current = latest.current
      if (!confirmed || !active.current || current.sessionId !== captured.sessionId) {
        return
      }
      if (
        current.state.epoch !== expectedEpoch ||
        current.state.cursor?.sequence !== captured.state.cursor?.sequence
      ) {
        toast.error(nativeChatRewindReasonCopy('stale-epoch'))
        return
      }
      const blocked = blockedReason(current)
      if (blocked) {
        toast.error(blocked)
        return
      }
      blockedRef.current = true
      setSending(true)
      const outcome = await current.send({ itemId, expectedEpoch })
      if (!active.current || latest.current.sessionId !== captured.sessionId) {
        return
      }
      const reset = latest.current.state.epoch !== expectedEpoch
      const giveBack = () => {
        if (returnTargetToComposer(captured, itemId)) {
          latest.current.onMessageReturned?.()
        }
      }
      if (outcome.kind === 'done') {
        giveBack()
        keepBlocked = !reset
        setAwaiting(reset ? null : { sessionId: captured.sessionId, epoch: expectedEpoch })
        return
      }
      if (outcome.kind === 'dropped') {
        return
      }
      const reason = rewindFailureReason(outcome.failure)
      // A rewind that may have run must never lose the message; a duplicate draft is harmless.
      if (reason === 'outcome-unknown') {
        giveBack()
      }
      if (reset) {
        return
      }
      toast.error(
        reason === 'outcome-unknown' && captured.composerScopeKey
          ? nativeChatRewindReturnedUnknownCopy()
          : nativeChatRewindReasonCopy(reason)
      )
    } finally {
      inFlight.current = false
      blockedRef.current = keepBlocked
      setSending(false)
    }
  }, [])
  /** Whether a send may go now; one refused during a confirmed rewind says why. */
  const admitsSend = useCallback((): boolean => {
    if (blockedRef.current) {
      toast.message(nativeChatRewindPendingCopy())
    }
    return !blockedRef.current
  }, [])
  /** Runs an action only while no confirmed rewind is in flight. */
  const unlessBlocked = useCallback(
    <A extends unknown[]>(run: (...input: A) => void) =>
      (...input: A): void => {
        if (admitsSend()) {
          run(...input)
        }
      },
    [admitsSend]
  )
  const offered = nativeChatRewindOffered(input.support)
  // Rows re-render only when this changes; none get the action where the provider can never rewind.
  const surface = useMemo<NativeChatRewindSurface | undefined>(
    () => (offered ? { disabledReason, request } : undefined),
    [offered, disabledReason, request]
  )
  return { request, admitsSend, unlessBlocked, surface, disabledReason, pending, blockedRef }
}

/** What the pane hosting a structured session tells its rewind. */
export type NativeChatRewindHost = {
  /** The host's in-doubt latch, from its status feed. */
  hostBlockedReason?: AgentSessionRewindReason | null
  onMessageReturned?: () => void
  isVisible?: boolean
}

/** The rewind a structured session's user rows offer, sent through the session's own writes. */
export function useStructuredAgentSessionRewind(
  args: Omit<RewindInput, keyof NativeChatRewindHost | 'send'> &
    NativeChatRewindHost & { target: RuntimeClientTarget; write: StructuredAgentSessionWrite }
) {
  const {
    blocked,
    composerScopeKey,
    hostBlockedReason,
    isVisible,
    onMessageReturned,
    sessionId,
    state,
    target,
    write
  } = args
  // An in-doubt rewind returns the prompt for the next send to settle; only a host that settles it
  // on a send may offer one. Unknown hides it, as unresolved support does.
  const support = useStructuredAgentSessionHostRecoversRewindOnSend(target)
    ? args.support
    : undefined
  const input = useMemo<RewindInput>(
    () => ({
      sessionId,
      composerScopeKey,
      onMessageReturned,
      isVisible,
      hostBlockedReason: hostBlockedReason ?? undefined,
      state,
      support,
      blocked,
      send: (fields) =>
        write<AgentSessionRewindResult>('agentSession.rewind', 'agentSession.rewind', fields)
    }),
    [
      blocked,
      composerScopeKey,
      hostBlockedReason,
      isVisible,
      onMessageReturned,
      sessionId,
      state,
      support,
      write
    ]
  )
  return useNativeChatRewind(input)
}
