import type { AntigravityLaunchResult } from './antigravity-launch-results'
import { isRecord } from '../../../agent-status/child-work/agent-status-child-work-value-guards'
import { antigravityRootTranscriptPath } from './antigravity-child-transcript'
import {
  antigravityHasPendingLaunch,
  recordAntigravityHelpersDrain,
  retireAntigravityChild,
  type AntigravityLaunch,
  type AntigravityPaneChildState
} from './antigravity-pane-state'

const PRE_TOOL_USE = 1
const POST_TOOL_USE = 2
const PAIRED = PRE_TOOL_USE | POST_TOOL_USE
const MAX_UNPAIRED_LAUNCHES = 256

function releaseLaunchIdentity(
  pane: AntigravityPaneChildState,
  step: number,
  launch: AntigravityLaunch
): void {
  pane.settledLaunches.delete(step)
  // A conflicting hook can leave this step's ownership live after its historical record goes away.
  if (!pane.pendingLaunches.has(step) && pane.launchStepsByCall.get(launch.callId) === step) {
    pane.launchStepsByCall.delete(launch.callId)
  }
  if (pane.currentLaunch === launch) {
    pane.currentLaunch = undefined
  }
}

function retainUnpairedLaunch(
  pane: AntigravityPaneChildState,
  step: number,
  launch: AntigravityLaunch
): void {
  if (pane.settledLaunches.size === MAX_UNPAIRED_LAUNCHES) {
    const oldest = pane.settledLaunches.entries().next()
    if (!oldest.done) {
      const [evictedStep, evictedLaunch] = oldest.value
      releaseLaunchIdentity(pane, evictedStep, evictedLaunch)
    }
  }
  pane.settledLaunches.set(step, launch)
}

function matchesLaunchResult(
  pane: AntigravityPaneChildState,
  launch: AntigravityLaunch,
  result: AntigravityLaunchResult | null | undefined
): result is AntigravityLaunchResult {
  if (!result || launch.toolName !== result.tool) {
    return false
  }
  if (result.outcome === 'rejected') {
    return (
      result.tool === 'invoke_subagent' ||
      (launch.swarmTranscriptPath !== undefined &&
        launch.swarmTranscriptPath === antigravityRootTranscriptPath(pane))
    )
  }
  return (
    (launch.swarmSize === undefined || result.children.length === launch.swarmSize) &&
    !result.children.includes(pane.rootConversationId ?? '')
  )
}

export function trackAntigravityLaunch(
  pane: AntigravityPaneChildState,
  eventName: 'PreToolUse' | 'PostToolUse',
  key: number | undefined,
  callId: string | undefined,
  toolName: string,
  args: unknown,
  transcriptPath: string | undefined,
  completedBookkeepingOnly = false
): 'current' | 'stale' | 'hold' {
  const phase = eventName === 'PreToolUse' ? PRE_TOOL_USE : POST_TOOL_USE
  const tasks = toolName === 'swarm' && isRecord(args) ? args.tasks : undefined
  const swarmSize = toolName === 'swarm' ? (Array.isArray(tasks) && tasks.length) || 1 : undefined
  const pending = pane.pendingLaunches.get(key)
  const settled = key === undefined ? undefined : pane.settledLaunches.get(key)
  const prior = settled ?? pending
  const older = key !== undefined && key <= (pane.rootStepFrontier ?? -1)
  if (
    prior &&
    prior.callId === callId &&
    prior.toolName === toolName &&
    prior.swarmSize === swarmSize &&
    (settled || !completedBookkeepingOnly || older)
  ) {
    const finishesCurrentLaunch =
      !completedBookkeepingOnly &&
      (!settled || pending === undefined) &&
      pane.currentLaunch === prior &&
      phase === POST_TOOL_USE &&
      (prior.phases & phase) === 0
    prior.phases |= phase
    if (settled && key !== undefined && prior.phases === PAIRED) {
      releaseLaunchIdentity(pane, key, settled)
    }
    return finishesCurrentLaunch ? 'current' : 'stale'
  }
  if (completedBookkeepingOnly && !older) {
    return 'stale'
  }
  const hadHold = older && antigravityHasPendingLaunch(pane)
  const priorStep = callId ? pane.launchStepsByCall.get(callId) : undefined
  if (priorStep !== undefined && priorStep !== key) {
    if (
      pane.currentLaunch ===
      (pane.settledLaunches.get(priorStep) ?? pane.pendingLaunches.get(priorStep))
    ) {
      pane.currentLaunch = undefined
    }
    pane.pendingLaunches.set(priorStep, null)
  }
  const swarmTranscriptPath =
    toolName === 'swarm' &&
    (pane.rootTranscriptPath === undefined || pane.rootTranscriptPath === transcriptPath)
      ? transcriptPath
      : undefined
  const launch =
    key !== undefined &&
    callId &&
    prior === undefined &&
    (priorStep === undefined || priorStep === key)
      ? { callId, toolName, swarmSize, swarmTranscriptPath, phases: phase }
      : null

  let cachedSuccessPending = false
  if (older && launch && transcriptPath && transcriptPath === antigravityRootTranscriptPath(pane)) {
    const result = pane.brainCache.transcripts.get(transcriptPath)?.launchResults?.get(key)
    if (matchesLaunchResult(pane, launch, result)) {
      if (result.outcome === 'rejected' || result.applied) {
        pane.launchStepsByCall.set(launch.callId, key)
        retainUnpairedLaunch(pane, key, launch)
        return 'stale'
      }
      // A known success stays keyed until the poll registers its children.
      cachedSuccessPending = true
    }
  }
  if (
    older &&
    prior === undefined &&
    !cachedSuccessPending &&
    (!launch || pane.pendingOlderLaunchStep !== undefined)
  ) {
    // Further uncorrelatable old phases share the root's unknown-launch hold.
    pane.pendingLaunches.set(undefined, null)
  } else {
    pane.pendingLaunches.set(key, launch)
    if (
      callId &&
      key !== undefined &&
      pane.pendingOlderLaunchStep !== key &&
      (priorStep === undefined || priorStep === key)
    ) {
      pane.launchStepsByCall.set(callId, key)
    }
    if (older && launch && !cachedSuccessPending) {
      pane.pendingOlderLaunchStep = key
    }
  }
  pane.helpersIdleAt = undefined
  if (older) {
    if (pane.currentLaunch === prior) {
      pane.currentLaunch = undefined
    }
    return hadHold ? 'stale' : 'hold'
  }
  pane.currentLaunch = launch ?? undefined
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
    if (!launch || !matchesLaunchResult(pane, launch, result)) {
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
    if (result.outcome === 'success') {
      result.applied = true
    }
    pane.pendingLaunches.delete(step)
    if (pane.pendingOlderLaunchStep === step) {
      pane.pendingOlderLaunchStep = undefined
    }
    if (launch.phases === PAIRED) {
      releaseLaunchIdentity(pane, step, launch)
    } else {
      retainUnpairedLaunch(pane, step, launch)
    }
    settled ||= result.outcome === 'success' || pane.leadState === 'done'
  }
  if (settled) {
    recordAntigravityHelpersDrain(pane)
  }
}
