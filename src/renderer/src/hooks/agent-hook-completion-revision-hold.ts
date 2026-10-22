import { useAppStore } from '@/store'
import type { AgentCompletionStatusSnapshot } from '@/components/terminal-pane/agent-completion-coordinator-types'
import { NOTIFICATION_COOLDOWN_MS } from '../../../shared/notification-burst-cooldown'
import type { NotificationDispatchResult } from '../../../shared/notification-settings-types'

/** Sends one request and reports main's answer (null: none); returns false when nothing was sent. */
export type HookLaneCompletionSubmit = (
  onResult: (result: NotificationDispatchResult | null) => void
) => boolean

type HeldRevision = {
  submit: HookLaneCompletionSubmit
  isCurrent: () => boolean
  expiresAt: number
}

type PaneRequests = {
  /** The done segment (`stateStartedAt`) of the pane's latest request. */
  segment: number | undefined
  requestSeq: number
  /** When main's cooldown from the latest request has surely passed; null while it is unanswered. */
  cooldownEndsAt: number | null
  held: HeldRevision | null
  timer: ReturnType<typeof setTimeout> | null
}

// Why: these answers mean a later request would be refused too, so a held revision is dropped.
const TERMINAL_REFUSALS: ReadonlySet<NotificationDispatchResult['reason']> = new Set([
  'disabled',
  'source-disabled',
  'host-muted',
  'not-supported',
  'blocked-by-system',
  'invalid-request'
])

const requestsByPaneKey = new Map<string, PaneRequests>()

function clearTimer(requests: PaneRequests): void {
  if (requests.timer !== null) {
    clearTimeout(requests.timer)
    requests.timer = null
  }
}

function armHeldTimer(requests: PaneRequests, submitAfterCooldown: () => void): void {
  const held = requests.held
  if (!held) {
    return
  }
  clearTimer(requests)
  const cooldownEndsAt = requests.cooldownEndsAt
  if (cooldownEndsAt !== null && cooldownEndsAt > held.expiresAt) {
    requests.held = null
    return
  }
  // Why: a fixed expiry, never extended by later revisions, also drops one whose answer never came.
  const dueAt = cooldownEndsAt ?? held.expiresAt
  requests.timer = setTimeout(
    () => {
      requests.timer = null
      if (cooldownEndsAt === null) {
        requests.held = null
        return
      }
      submitAfterCooldown()
    },
    Math.max(0, dueAt - Date.now())
  )
}

function submitNow(
  paneKey: string,
  requests: PaneRequests,
  segment: number | undefined,
  submit: HookLaneCompletionSubmit
): void {
  const seq = ++requests.requestSeq
  requests.segment = segment
  requests.cooldownEndsAt = null
  const sent = submit((result) => {
    if (requestsByPaneKey.get(paneKey) !== requests || requests.requestSeq !== seq) {
      return
    }
    // Why: main reserved its cooldown before answering, so counting from the answer is conservative.
    requests.cooldownEndsAt = Date.now() + NOTIFICATION_COOLDOWN_MS
    if (result && !result.delivered && TERMINAL_REFUSALS.has(result.reason)) {
      requests.held = null
      clearTimer(requests)
      return
    }
    armHeldTimer(requests, () => submitHeld(paneKey, requests))
  })
  if (!sent && requests.requestSeq === seq) {
    requests.cooldownEndsAt = 0
  }
}

function submitHeld(paneKey: string, requests: PaneRequests): void {
  const held = requests.held
  requests.held = null
  // One attempt: owner, state and capability are rechecked here, focus and settings by main.
  if (held?.isCurrent()) {
    submitNow(paneKey, requests, requests.segment, held.submit)
  }
}

/**
 * The hook lane's completion requests for one pane. A later turn end in the same done segment
 * (a Stop re-entered after a blocking Stop hook) that arrives while main's cooldown from the
 * preceding request still runs would be dropped there; the latest one is held and sent once,
 * after that cooldown, through main's unchanged gates. Everything else is sent at once.
 */
export function submitHookLaneCompletion(
  paneKey: string,
  snapshot: AgentCompletionStatusSnapshot | undefined,
  lane: { keepsAuthority: () => boolean; submit: HookLaneCompletionSubmit }
): void {
  const done = snapshot?.state === 'done' ? snapshot : undefined
  const segment = done?.stateStartedAt
  // Why: sent only while the pane still shows this end and the lane keeps hook authority.
  const isCurrent = (): boolean => {
    const row = useAppStore.getState().agentStatusByPaneKey[paneKey]
    return (
      row?.state === 'done' &&
      row.stateStartedAt === segment &&
      row.turnEndedAt === done?.turnEndedAt &&
      lane.keepsAuthority()
    )
  }
  let requests = requestsByPaneKey.get(paneKey)
  if (!requests) {
    requests = { segment: undefined, requestSeq: 0, cooldownEndsAt: 0, held: null, timer: null }
    requestsByPaneKey.set(paneKey, requests)
  }
  const coolingDown = requests.cooldownEndsAt === null || Date.now() < requests.cooldownEndsAt
  if (
    done?.turnEndedAt !== undefined &&
    segment !== undefined &&
    segment === requests.segment &&
    coolingDown
  ) {
    requests.held = {
      submit: lane.submit,
      isCurrent,
      expiresAt: requests.held?.expiresAt ?? Date.now() + 2 * NOTIFICATION_COOLDOWN_MS
    }
    const paneRequests = requests
    armHeldTimer(requests, () => submitHeld(paneKey, paneRequests))
    return
  }
  clearTimer(requests)
  requests.held = null
  submitNow(paneKey, requests, segment, lane.submit)
}

export function discardHookLaneCompletionRequests(paneKey: string): void {
  const requests = requestsByPaneKey.get(paneKey)
  if (requests) {
    clearTimer(requests)
    requestsByPaneKey.delete(paneKey)
  }
}
