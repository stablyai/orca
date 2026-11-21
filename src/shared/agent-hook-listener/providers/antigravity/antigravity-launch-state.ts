import type { AntigravityLaunchResult } from './antigravity-launch-results'
import { isRecord } from '../../../agent-status/child-work/agent-status-child-work-value-guards'
import {
  recordAntigravityHelpersDrain,
  retireAntigravityChild,
  type AntigravityLaunch,
  type AntigravityPaneChildState
} from './antigravity-pane-state'

const PRE_TOOL_USE = 1
const POST_TOOL_USE = 2
const PAIRED = PRE_TOOL_USE | POST_TOOL_USE

function releasePairedLaunch(
  pane: AntigravityPaneChildState,
  step: number,
  launch: AntigravityLaunch
): void {
  pane.settledLaunches.delete(step)
  // A conflicting hook can leave this step held even after the original pair arrives.
  if (!pane.pendingLaunches.has(step)) {
    pane.launchStepsByCall.delete(launch.callId)
  }
  if (pane.currentLaunch === launch) {
    pane.currentLaunch = undefined
  }
}

export function trackAntigravityLaunch(
  pane: AntigravityPaneChildState,
  eventName: 'PreToolUse' | 'PostToolUse',
  step: unknown,
  callId: string | undefined,
  toolName: string,
  args: unknown,
  completedBookkeepingOnly = false
): 'current' | 'stale' {
  const phase = eventName === 'PreToolUse' ? PRE_TOOL_USE : POST_TOOL_USE
  const key = typeof step === 'number' && Number.isSafeInteger(step) && step >= 0 ? step : undefined
  const tasks = toolName === 'swarm' && isRecord(args) ? args.tasks : undefined
  const swarmSize = toolName === 'swarm' ? (Array.isArray(tasks) && tasks.length) || 1 : undefined
  const pending = pane.pendingLaunches.get(key)
  const settled = key === undefined ? undefined : pane.settledLaunches.get(key)
  const prior = settled ?? pending
  if (
    prior &&
    prior.callId === callId &&
    prior.toolName === toolName &&
    prior.swarmSize === swarmSize
  ) {
    if (settled && key !== undefined) {
      const finishesCurrentLaunch =
        !completedBookkeepingOnly &&
        pending === undefined &&
        pane.currentLaunch === settled &&
        phase === POST_TOOL_USE &&
        (settled.phases & phase) === 0
      settled.phases |= phase
      if (settled.phases === PAIRED) {
        releasePairedLaunch(pane, key, settled)
      }
      return finishesCurrentLaunch ? 'current' : 'stale'
    }
    if (!completedBookkeepingOnly) {
      prior.phases |= phase
      pane.currentLaunch = prior
      return 'current'
    }
  }
  if (completedBookkeepingOnly) {
    return 'stale'
  }
  const priorStep = callId ? pane.launchStepsByCall.get(callId) : undefined
  if (priorStep !== undefined && priorStep !== key) {
    pane.pendingLaunches.set(priorStep, null)
  } else if (callId && key !== undefined) {
    pane.launchStepsByCall.set(callId, key)
  }
  const launch =
    key !== undefined &&
    callId &&
    prior === undefined &&
    (priorStep === undefined || priorStep === key)
      ? { callId, toolName, swarmSize, phases: phase }
      : null
  pane.pendingLaunches.set(key, launch)
  pane.currentLaunch = launch ?? undefined
  pane.helpersIdleAt = undefined
  return 'current'
}

export function applyAntigravityLaunchResults(
  pane: AntigravityPaneChildState,
  results: ReadonlyMap<number, AntigravityLaunchResult | null>,
  now: number
): void {
  let settled = false
  for (const [step, result] of results) {
    const launch = pane.pendingLaunches.get(step)
    if (
      !launch ||
      !result ||
      launch.toolName !== result.tool ||
      (launch.swarmSize !== undefined && result.children.length !== launch.swarmSize) ||
      result.children.includes(pane.rootConversationId ?? '')
    ) {
      continue
    }
    for (const id of result.children) {
      if (pane.retiredChildren.has(id) || pane.verifiedChildren.has(id)) {
        continue
      }
      const child = pane.children.get(id)
      if (child?.stopped) {
        retireAntigravityChild(pane, id)
      } else {
        pane.expectedChildren.add(id)
        if (!child) {
          pane.children.set(id, { id, startedAt: now, revision: 0, state: 'working' })
        }
      }
    }
    pane.pendingLaunches.delete(step)
    if (launch.phases === PAIRED) {
      releasePairedLaunch(pane, step, launch)
    } else {
      pane.settledLaunches.set(step, launch)
    }
    settled ||= result.children.length > 0 || pane.leadState === 'done'
  }
  if (settled) {
    recordAntigravityHelpersDrain(pane)
  }
}
