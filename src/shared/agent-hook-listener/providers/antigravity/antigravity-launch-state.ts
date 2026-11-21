import type { AntigravityLaunchResult } from './antigravity-launch-results'
import { isRecord } from '../../../agent-status/child-work/agent-status-child-work-value-guards'
import {
  recordAntigravityHelpersDrain,
  retireAntigravityChild,
  type AntigravityPaneChildState
} from './antigravity-pane-state'

export function trackAntigravityLaunch(
  pane: AntigravityPaneChildState,
  step: unknown,
  callId: string | undefined,
  toolName: string,
  args: unknown
): void {
  const key = typeof step === 'number' && Number.isSafeInteger(step) && step >= 0 ? step : undefined
  const tasks = toolName === 'swarm' && isRecord(args) ? args.tasks : undefined
  const swarmSize = toolName === 'swarm' ? (Array.isArray(tasks) && tasks.length) || 1 : undefined
  const pending = pane.pendingLaunches.get(key)
  const prior = pending === undefined && key !== undefined ? pane.settledLaunches.get(key) : pending
  if (
    prior &&
    prior.callId === callId &&
    prior.toolName === toolName &&
    prior.swarmSize === swarmSize
  ) {
    return
  }
  const priorStep = callId ? pane.launchStepsByCall.get(callId) : undefined
  if (priorStep !== undefined && priorStep !== key) {
    pane.pendingLaunches.set(priorStep, null)
  } else if (callId && key !== undefined) {
    pane.launchStepsByCall.set(callId, key)
  }
  pane.pendingLaunches.set(
    key,
    key !== undefined &&
      callId &&
      prior === undefined &&
      (priorStep === undefined || priorStep === key)
      ? { callId, toolName, swarmSize }
      : null
  )
  pane.helpersIdleAt = undefined
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
    pane.settledLaunches.set(step, launch)
    settled ||= result.children.length > 0 || pane.leadState === 'done'
  }
  if (settled) {
    recordAntigravityHelpersDrain(pane)
  }
}
