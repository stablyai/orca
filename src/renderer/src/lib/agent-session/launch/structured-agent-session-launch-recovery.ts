import { structuredAgentSessionSettledSends } from '../../../../../shared/agent-session/requests/structured-agent-session-send-settlement'
import type { AgentSessionWriteFailure } from '../../../../../shared/agent-session/failures/agent-session-write-failure'
import type { AgentSessionHistoryResult } from '../../../../../shared/agent-session/agent-session-wire'
import type { AgentJournalCursor } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  launchStructuredAgentSession,
  type StructuredLaunchHostSeedListener
} from './structured-agent-session-launch-create-call'
import {
  StructuredAgentSessionCreateRefusalError,
  StructuredAgentSessionCreateUnknownOutcomeError
} from './structured-agent-session-launch-errors'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { readStructuredSessionTabInventory } from '@/runtime/structured-session-tab-inventory'
import { publishStructuredAgentSessionCreateHydration } from './structured-agent-session-create-hydration'
import { observeStructuredHostLaunch } from './structured-agent-session-host-launch'
import { ordinaryLaunchOpening } from './structured-agent-session-launch-opening'

export type StructuredAgentLaunchReceipt = {
  sessionId: string
  fence: number
  firstMessage?: AgentJournalSubmission
  cursor?: AgentJournalCursor
  configurationFailure?: AgentSessionWriteFailure
}

export type StructuredLaunchRecoveryState = {
  intent: StructuredAgentSessionLaunchIntent
  promise: Promise<StructuredAgentLaunchReceipt>
  visibilityUnknown: boolean
  cancelled: boolean
  onVisibilityChanged?: () => void
  onHostSeed?: StructuredLaunchHostSeedListener
}

export class StructuredAgentSessionLaunchCancelledError extends Error {
  constructor() {
    super('structured session launch cancelled')
    this.name = 'StructuredAgentSessionLaunchCancelledError'
  }
}

function throwIfLaunchCancelled(state: StructuredLaunchRecoveryState): void {
  if (state.cancelled) {
    throw new StructuredAgentSessionLaunchCancelledError()
  }
}

async function verifyPublishedSession(state: StructuredLaunchRecoveryState): Promise<void> {
  const snapshots = await readStructuredSessionTabInventory(state.intent.target)
  throwIfLaunchCancelled(state)
  const published = snapshots.some(
    (snapshot) =>
      snapshot.worktree === state.intent.worktreeId &&
      snapshot.tabs.some(
        (tab) => tab.type === 'agent-session' && tab.sessionId === state.intent.sessionId
      )
  )
  if (!published) {
    throw new Error('structured session tab publication unavailable')
  }
}

export async function recoverPublishedSessionReceipt(
  state: StructuredLaunchRecoveryState
): Promise<StructuredAgentLaunchReceipt> {
  await verifyPublishedSession(state)
  const history = await callStructuredAgentSession<AgentSessionHistoryResult>(
    state.intent.target,
    'agentSession.history',
    { sessionId: state.intent.sessionId, direction: 'tail', limit: 1 }
  )
  throwIfLaunchCancelled(state)
  const fence = history.page.fence ?? (!history.ok ? history.fence : undefined)
  if (typeof fence !== 'number') {
    throw new Error('structured session fence publication unavailable')
  }
  const opening = ordinaryLaunchOpening(state.intent)
  const firstMessage = opening
    ? structuredAgentSessionSettledSends(history.page.submissions, []).recorded.get(
        opening.clientMessageId
      )
    : undefined
  if (opening && !firstMessage) {
    if (state.intent.createMessageSupport === true) {
      publishStructuredAgentSessionCreateHydration(state.intent, history.page, fence)
    }
    throw new StructuredAgentSessionCreateUnknownOutcomeError(
      'The history page did not confirm the opening message.',
      'agent_session_operation_unknown'
    )
  }
  if (state.intent.createMessageSupport === true) {
    publishStructuredAgentSessionCreateHydration(state.intent, history.page, fence)
  }
  return {
    sessionId: state.intent.sessionId,
    fence,
    ...(firstMessage
      ? { firstMessage, cursor: history.page.liveCursor ?? history.page.window.nextCursor }
      : {})
  }
}

async function retrySameIntent(
  state: StructuredLaunchRecoveryState,
  priorError: unknown
): Promise<StructuredAgentLaunchReceipt> {
  throwIfLaunchCancelled(state)
  try {
    const receipt = await launchStructuredAgentSession(
      state.intent,
      state.onHostSeed,
      true,
      () => state.cancelled
    )
    throwIfLaunchCancelled(state)
    return receipt
  } catch (error) {
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      throw error
    }
    try {
      return await recoverPublishedSessionReceipt(state)
    } catch {
      if (state.cancelled) {
        throw new StructuredAgentSessionLaunchCancelledError()
      }
      state.visibilityUnknown = true
      state.onVisibilityChanged?.()
      throw error ?? priorError
    }
  }
}

export async function launchAndReconcile(
  state: StructuredLaunchRecoveryState
): Promise<StructuredAgentLaunchReceipt> {
  throwIfLaunchCancelled(state)
  const { hostLaunch } = state.intent
  if (hostLaunch) {
    return observeStructuredHostLaunch(state, hostLaunch, () => throwIfLaunchCancelled(state))
  }
  let receipt: StructuredAgentLaunchReceipt
  try {
    receipt = await launchStructuredAgentSession(
      state.intent,
      state.onHostSeed,
      false,
      () => state.cancelled
    )
  } catch (error) {
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      throw error
    }
    try {
      return await recoverPublishedSessionReceipt(state)
    } catch {
      if (ordinaryLaunchOpening(state.intent)) {
        state.visibilityUnknown = true
        state.onVisibilityChanged?.()
        throw error
      }
      return retrySameIntent(state, error)
    }
  }
  throwIfLaunchCancelled(state)
  return receipt
}

export async function reconcileUnknownLaunch(
  state: StructuredLaunchRecoveryState,
  requested = false
): Promise<StructuredAgentLaunchReceipt> {
  throwIfLaunchCancelled(state)
  // The host's own record of its launch answers; a lost observer never sends anything new.
  const { hostLaunch } = state.intent
  if (hostLaunch) {
    state.visibilityUnknown = false
    state.onVisibilityChanged?.()
    return observeStructuredHostLaunch(state, hostLaunch, () => throwIfLaunchCancelled(state))
  }
  if (ordinaryLaunchOpening(state.intent) && !requested) {
    return recoverPublishedSessionReceipt(state)
  }
  if (!ordinaryLaunchOpening(state.intent)) {
    state.visibilityUnknown = false
    state.onVisibilityChanged?.()
  }
  try {
    return await recoverPublishedSessionReceipt(state)
  } catch (error) {
    return retrySameIntent(state, error)
  }
}
