import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import type {
  AgentSessionRewindReason,
  AgentSessionRewindResult,
  AgentSessionRewindSupport
} from '../../../../shared/agent-session-rewind'
import type { AgentSessionWireRefusal } from '../../../../shared/agent-session-wire'
import type { StructuredAgentSessionState } from '../../../../shared/structured-agent-session-reducer'
import {
  nativeChatRewindReasonCopy,
  nativeChatRewindUnavailableCopy
} from './native-chat-rewind-copy'

export type NativeChatRewindSurface = {
  disabledReason: string | null
  request: (itemId: string) => void
}

type RewindInput = {
  sessionId: string
  state: StructuredAgentSessionState
  support: AgentSessionRewindSupport | undefined
  supportResolved: boolean
  hostBlockedReason?: AgentSessionRewindReason
  blocked: boolean
  send: (
    fields: { itemId: string; expectedEpoch: string },
    onFailure: (refusal?: AgentSessionWireRefusal) => void
  ) => Promise<AgentSessionRewindResult | null>
}

export function countNativeChatRewindMessages(
  state: StructuredAgentSessionState,
  itemId: string
): number {
  const index = state.items.findIndex(
    (item) => item.itemId === itemId && item.body.kind === 'message' && item.body.role === 'user'
  )
  return index === -1
    ? 0
    : state.items.slice(index).filter((item) => item.body.kind === 'message').length
}

function blockedReason(input: RewindInput): string | null {
  if (input.hostBlockedReason) {
    return nativeChatRewindReasonCopy(input.hostBlockedReason)
  }
  if (input.support?.supported === false) {
    return nativeChatRewindReasonCopy(input.support.reason)
  }
  const { state } = input
  if (
    !input.supportResolved ||
    !state.epoch ||
    state.fence === null ||
    state.status !== 'ready' ||
    (state.handoff && (state.handoff.owner !== 'native' || state.handoff.phase !== 'idle'))
  ) {
    return nativeChatRewindUnavailableCopy()
  }
  return input.blocked ? nativeChatRewindReasonCopy('busy') : null
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
  const inFlight = useRef(false)
  const [pending, setPending] = useState(false)
  const [settlement, setSettlement] = useState<{
    sessionId: string
    epoch: string
    nextEpoch?: string
  } | null>(null)
  const [failure, setFailure] = useState<{
    sessionId: string
    epoch: string | null
    message: string
  } | null>(null)
  const setError = (message: string | null) => {
    const current = latest.current
    setFailure(
      message ? { sessionId: current.sessionId, epoch: current.state.epoch, message } : null
    )
  }
  const awaitingReset =
    settlement?.sessionId === input.sessionId && settlement.epoch === input.state.epoch
  const confirmedResetPending = awaitingReset && Boolean(settlement?.nextEpoch)
  // The host also holds its recovery latch while our request is still in flight.
  const error =
    input.hostBlockedReason && !pending && !confirmedResetPending
      ? nativeChatRewindReasonCopy(input.hostBlockedReason)
      : failure?.sessionId === input.sessionId && failure.epoch === input.state.epoch
        ? failure.message
        : null
  const disabledReason =
    pending || awaitingReset
      ? awaitingReset && !settlement?.nextEpoch
        ? nativeChatRewindReasonCopy('outcome-unknown')
        : translate(
            'components.native-chat.rewind.pending',
            'Rewind is in progress. Wait for the conversation to reload.'
          )
      : blockedReason(input)
  const blockedRef = useRef(false)
  useLayoutEffect(() => {
    blockedRef.current = pending || awaitingReset || Boolean(input.hostBlockedReason)
  }, [pending, awaitingReset, input.hostBlockedReason])

  const request = useCallback(async (itemId: string, confirm: ConfirmationDialogContextValue) => {
    const captured = latest.current
    if (inFlight.current || blockedRef.current || blockedReason(captured)) {
      return
    }
    const expectedEpoch = captured.state.epoch!
    const count = countNativeChatRewindMessages(captured.state, itemId)
    if (!count) {
      return
    }
    inFlight.current = true
    blockedRef.current = true
    setPending(true)
    setError(null)
    let keepBlocked = false
    try {
      const confirmed = await confirm({
        title: translate('components.native-chat.rewind.title', 'Revert to here?'),
        description: translate(
          'components.native-chat.rewind.confirmation',
          'Discard this message and every later message ({{count}} in total)? This cannot be undone. Your composer draft and attachments will be cleared. File changes on disk will be kept.',
          { count }
        ),
        confirmLabel: translate('components.native-chat.rewind.confirm', 'Discard messages'),
        cancelLabel: translate('components.native-chat.rewind.cancel', 'Cancel'),
        confirmVariant: 'destructive',
        cancelVariant: 'ghost'
      })
      if (!confirmed) {
        return
      }
      const current = latest.current
      if (!active.current || current.sessionId !== captured.sessionId) {
        return
      }
      if (
        current.state.epoch !== expectedEpoch ||
        current.state.cursor?.sequence !== captured.state.cursor?.sequence
      ) {
        setError(nativeChatRewindReasonCopy('stale-epoch'))
        return
      }
      const reason = blockedReason(current)
      if (reason) {
        setError(reason)
        return
      }
      const result = await current.send({ itemId, expectedEpoch }, (refusal) => {
        if (
          !active.current ||
          latest.current.sessionId !== captured.sessionId ||
          latest.current.state.epoch !== expectedEpoch
        ) {
          return
        }
        const unknown =
          !refusal ||
          refusal.rewindReason === 'outcome-unknown' ||
          refusal.code === 'agent_session_operation_unknown'
        setError(nativeChatRewindReasonCopy(unknown ? 'outcome-unknown' : refusal.rewindReason))
        if (unknown) {
          keepBlocked = latest.current.state.epoch === expectedEpoch
          setSettlement({ sessionId: captured.sessionId, epoch: expectedEpoch })
        }
      })
      if (result && active.current && latest.current.sessionId === captured.sessionId) {
        keepBlocked = latest.current.state.epoch === expectedEpoch
        setSettlement({
          sessionId: captured.sessionId,
          epoch: expectedEpoch,
          nextEpoch: result.epoch
        })
      }
    } finally {
      inFlight.current = false
      blockedRef.current = keepBlocked || Boolean(latest.current.hostBlockedReason)
      setPending(false)
    }
  }, [])
  return {
    request,
    disabledReason,
    pending: pending || awaitingReset || Boolean(input.hostBlockedReason),
    blockedRef,
    error
  }
}
