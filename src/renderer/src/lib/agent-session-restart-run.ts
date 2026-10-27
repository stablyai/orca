import {
  agentSessionRestartQueueMessage,
  agentSessionRestartSkipMessage,
  type AgentSessionRestartFence,
  type AgentSessionRestartPane,
  type AgentSessionRestartSkipReason,
  type AgentSessionRestartTarget
} from './agent-session-restart-plan'
import type { AgentSessionRestartStartup } from './agent-session-restart-startup'
import { translate } from '@/i18n/i18n'
import {
  judgeAgentSessionRestartSpawn,
  type AgentSessionRestartSpawnResult
} from './agent-session-restart-verdict'

export type AgentSessionRestartPlacement = 'mounted' | 'unmounted' | 'open-unready'

export type AgentSessionRestartFenceCheck = 'ok' | 'removed' | 'pane-changed'

export type AgentSessionRestartOutcomeStatus =
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'queued'
  | 'pending'

export type AgentSessionRestartOutcome = {
  ptyId: string
  agent: string
  label: string
  workspaceLabel: string
  status: AgentSessionRestartOutcomeStatus
  message: string
  /** Set only after main kept the requested provider session on a fresh process. */
  newPtyId: string | null
  /** A new process that did not restore the session. The caller must reap it and not adopt it. */
  reapPtyId: string | null
}

export type AgentSessionRestartRunDeps = {
  revalidate: (fence: AgentSessionRestartFence) => AgentSessionRestartFenceCheck
  /** Current turn state. Omitted means the planned state is still current. */
  readiness?: (pane: AgentSessionRestartPane) => 'ready' | 'busy' | 'blocked'
  buildStartup: (
    target: Extract<AgentSessionRestartTarget, { kind: 'restart' | 'queued' }>
  ) => AgentSessionRestartStartup | null
  placement: (pane: AgentSessionRestartPane) => AgentSessionRestartPlacement
  spawnMounted: (
    startup: AgentSessionRestartStartup,
    pane: AgentSessionRestartPane
  ) => Promise<AgentSessionRestartSpawnResult>
  spawnUnmounted: (
    startup: AgentSessionRestartStartup,
    pane: AgentSessionRestartPane
  ) => Promise<AgentSessionRestartSpawnResult>
}

const FENCE_MESSAGE: Record<Exclude<AgentSessionRestartFenceCheck, 'ok'>, string> = {
  removed: agentSessionRestartRemovedMessage(),
  'pane-changed': agentSessionRestartChangedMessage()
}

export function agentSessionRestartChangedMessage(): string {
  return 'the terminal changed before restart'
}

export function agentSessionRestartRemovedMessage(): string {
  return 'the terminal was closed'
}

const STARTUP_UNAVAILABLE = 'the exact resume command could not be built'
const OPEN_UNREADY = 'Waiting for the open terminal'
const STARTED = 'new process started with original session resume command'

export async function runAgentSessionRestartTargets(
  targets: readonly AgentSessionRestartTarget[],
  deps: AgentSessionRestartRunDeps
): Promise<AgentSessionRestartOutcome[]> {
  const outcomes: AgentSessionRestartOutcome[] = []
  for (const target of targets) {
    outcomes.push(await runOne(target, deps))
  }
  return outcomes
}

export function summarizeAgentSessionRestartOutcomes(
  outcomes: readonly AgentSessionRestartOutcome[]
): string {
  const counts: Record<AgentSessionRestartOutcomeStatus, number> = {
    succeeded: 0,
    failed: 0,
    skipped: 0,
    queued: 0,
    pending: 0
  }
  for (const outcome of outcomes) {
    counts[outcome.status] += 1
  }
  const parts = [
    counts.succeeded ? `${counts.succeeded} restarted` : '',
    counts.failed ? `${counts.failed} failed` : '',
    counts.skipped ? `${counts.skipped} skipped` : '',
    counts.queued ? `${counts.queued} queued` : '',
    counts.pending ? `${counts.pending} pending` : ''
  ].filter((part) => part.length > 0)
  return parts.join(', ')
}

export function formatAgentSessionRestartOutcome(outcome: AgentSessionRestartOutcome): string {
  if (outcome.status === 'queued' || outcome.status === 'pending') {
    const place = outcome.workspaceLabel
      ? `${outcome.label} in ${outcome.workspaceLabel}`
      : outcome.label
    const title =
      outcome.status === 'queued'
        ? translate('settings.manageSessions.queuedLabel', 'Queued')
        : translate('settings.manageSessions.pendingLabel', 'Pending')
    return `${title}: ${place} — ${outcome.message}`
  }
  const title =
    outcome.status === 'succeeded'
      ? translate('settings.manageSessions.restartedLabel', 'Restarted')
      : outcome.status === 'failed'
        ? translate('settings.manageSessions.failedLabel', 'Failed')
        : translate('settings.manageSessions.skippedLabel', 'Skipped')
  return `${title}: ${outcome.label} — ${outcome.message}`
}

async function runOne(
  target: AgentSessionRestartTarget,
  deps: AgentSessionRestartRunDeps
): Promise<AgentSessionRestartOutcome> {
  if (target.kind === 'skipped') {
    return outcome(target, 'skipped', agentSessionRestartSkipMessage(target.reason), null)
  }
  if (target.kind === 'queued') {
    const ready = deps.readiness?.(target.pane)
    if (ready !== 'ready') {
      return outcome(
        target,
        'queued',
        agentSessionRestartQueueMessage(ready === 'blocked' ? 'blocked' : target.queueReason),
        null
      )
    }
  }

  const fence = readFence(target.fence, deps)
  if (fence !== 'ok') {
    return outcome(target, 'skipped', FENCE_MESSAGE[fence], null)
  }
  const readiness = deps.readiness?.(target.pane) ?? 'ready'
  if (readiness !== 'ready') {
    return outcome(target, 'queued', agentSessionRestartQueueMessage(readiness), null)
  }
  if (deps.placement(target.pane) === 'open-unready') {
    return outcome(target, 'pending', OPEN_UNREADY, null)
  }

  const startup = deps.buildStartup(target)
  if (!startup) {
    return outcome(target, 'skipped', STARTUP_UNAVAILABLE, null)
  }
  // Rebuild can observe a newer store. Do not spawn a command into a pane that changed while building.
  const fenceAfterBuild = readFence(target.fence, deps)
  if (fenceAfterBuild !== 'ok') {
    return outcome(target, 'skipped', FENCE_MESSAGE[fenceAfterBuild], null)
  }

  const spawn = deps.placement(target.pane) === 'mounted' ? deps.spawnMounted : deps.spawnUnmounted
  let result: AgentSessionRestartSpawnResult
  try {
    result = await spawn(startup, target.pane)
  } catch {
    return outcome(target, 'failed', 'the new process did not start', null)
  }
  if (result?.deferred) {
    return outcome(target, 'pending', OPEN_UNREADY, null)
  }
  const verdict = judgeAgentSessionRestartSpawn(target.fence.providerSessionId, result)
  if (!verdict.ok) {
    return outcome(target, 'failed', verdict.message, verdict.reapPtyId)
  }
  return outcome(target, 'succeeded', STARTED, null, verdict.ptyId)
}

function readFence(
  fence: AgentSessionRestartFence,
  deps: AgentSessionRestartRunDeps
): AgentSessionRestartFenceCheck {
  return deps.revalidate(fence)
}

function outcome(
  target: AgentSessionRestartTarget,
  status: AgentSessionRestartOutcomeStatus,
  message: string,
  reapPtyId: string | null,
  newPtyId: string | null = null
): AgentSessionRestartOutcome {
  return {
    ptyId: target.pane.ptyId,
    agent: target.pane.agent,
    label: target.label,
    workspaceLabel: target.workspaceLabel,
    status,
    message,
    newPtyId,
    reapPtyId
  }
}

export type { AgentSessionRestartSkipReason }
