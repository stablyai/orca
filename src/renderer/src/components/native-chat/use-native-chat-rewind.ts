import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import {
  savedRewindKeys,
  isAgentSessionRewindTarget,
  type AgentSessionRewindReason,
  type AgentSessionRewindResult,
  type AgentSessionRewindSupport
} from '../../../../shared/agent-session-rewind'
import { readAgentJournalTurn } from '../../../../shared/agent-session-turn-record'
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
  CaptureStructuredAgentSessionPresentation,
  StructuredAgentSessionWriteOutcome
} from './use-structured-agent-session-mutate'
import { returnMessageToComposer } from './structured-agent-session-message-hand-back'
import { nativeChatRewindOffered } from './native-chat-rewind-eligibility'
import type { NativeChatRewindSurface } from './use-native-chat-rewind-host'
import {
  agentSessionContextFloorSequence,
  latestAgentSessionContextClearSequence
} from '../../../../shared/agent-session-context-clear'
import type { AgentJournalCursor } from '../../../../shared/agent-session-journal-types'

/** How long a confirmed rewind waits for its new conversation before letting go. */
export const NATIVE_CHAT_REWIND_RESET_TIMEOUT_MS = 120_000

export type RewindInput = {
  sessionId: string
  capturePresentation: CaptureStructuredAgentSessionPresentation
  /** The composer the discarded message returns to, after whatever is typed there. */
  composerScopeKey?: string
  /** Called once the discarded message is back in the composer. */
  onMessageReturned?: () => void
  /** Whether the pane is shown, and so reading; absent means shown. */
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

function isRewindTarget(input: RewindInput, itemId: string): boolean {
  const opener = turnOpeners(input.state.items)
  const keys = savedRewindKeys(input.state.submissions)
  return input.state.items.some(
    (item) =>
      item.itemId === itemId &&
      item.sequence > rewindContextFloor(input) &&
      (keys.nativeIdentity(itemId) !== null || !keys.hasSubmission(itemId)) &&
      isAgentSessionRewindTarget(item, (turn) => opener.get(turn))
  )
}

function turnOpeners(items: StructuredAgentSessionState['items']): Map<string, string> {
  const openers = new Map<string, string>()
  for (const item of items) {
    const opener = readAgentJournalTurn(item.body)?.userItemId
    if (opener) {
      openers.set(item.itemId, opener)
    }
  }
  return openers
}

function rewindContextFloor(input: RewindInput): number {
  return Math.max(
    latestAgentSessionContextClearSequence(input.state.items),
    agentSessionContextFloorSequence(input.contextFloor, input.state.epoch)
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
  const latest = useRef(input)
  useLayoutEffect(() => {
    latest.current = input
    active.current = true
    return () => {
      active.current = false
    }
  }, [input])
  // Reserve single-flight at the first click; only confirmed sending blocks other actions.
  const inFlight = useRef(false)
  const [sending, setSending] = useState(false)
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
  // Hidden panes stop reading; missing reset evidence while hidden is not a failure.
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
        toast.error(nativeChatRewindTimeoutCopy())
      }
    }, NATIVE_CHAT_REWIND_RESET_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [awaiting, awaitingReset])
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
      !isRewindTarget(captured, itemId)
    ) {
      return
    }
    const isCurrent = captured.capturePresentation()
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
      const reason = outcome.kind === 'not-done' ? rewindFailureReason(outcome.failure) : undefined
      // Captured content belongs to the conversation even after its pane closes.
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
  /** Refuse sends during confirmed rewind and explain why. */
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
  const floor = rewindContextFloor(input)
  const eligibleItemIds = useMemo(() => {
    const opener = turnOpeners(input.state.items)
    const keys = savedRewindKeys(input.state.submissions)
    return new Set(
      input.state.items
        .filter(
          (item) =>
            item.sequence > floor &&
            (keys.nativeIdentity(item.itemId) !== null || !keys.hasSubmission(item.itemId)) &&
            isAgentSessionRewindTarget(item, (turn) => opener.get(turn))
        )
        .map((item) => item.itemId)
    )
  }, [floor, input.state.items, input.state.submissions])
  // Memoize row actions and omit them entirely for providers without rewind.
  const surface = useMemo<NativeChatRewindSurface | undefined>(
    () => (offered ? { disabledReason, request, eligibleItemIds } : undefined),
    [offered, disabledReason, request, eligibleItemIds]
  )
  return { request, admitsSend, unlessBlocked, surface, disabledReason, pending, blockedRef }
}

export type { NativeChatRewindHost, NativeChatRewindSurface } from './use-native-chat-rewind-host'
