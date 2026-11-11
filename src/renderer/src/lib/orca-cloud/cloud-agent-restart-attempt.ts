// RA-11 Restart on the Orca Cloud strip: the attempt the strip shows ("Restarting…", then a result)
// and the mark that lets it run while the signed-out agent reports 'blocked'.
import type { HostAgentSignInAgent } from '../../../../shared/host-agent-sign-in-status'
import { clearCloudRunningSignout, notifyCloudRunningStrips } from './cloud-running-agent-signout'

/**
 * RA-11 Restart the person clicked on a signed-out cloud pane. Its Claude reports 'blocked' after the
 * failed turn, which the account-restart path otherwise reads as mid-turn and waits on forever.
 */
const forcedRestarts = new Set<string>()

/** Whether a queued restart on this PTY was asked for on the RA-11 strip (and may run now). */
export function isForcedCloudAgentRestart(ptyId: string): boolean {
  return forcedRestarts.has(ptyId)
}

/**
 * A Restart in flight on a pane: the strip shows "Restarting…" until the relaunched agent reports,
 * or "Couldn't restart" when nothing relaunched in time. Never vanishes without a result.
 */
export type CloudAgentRestartAttempt = {
  phase: 'restarting' | 'failed'
  agent: HostAgentSignInAgent
  resumable: boolean
  ptyId: string
  /** Set when the pane's restart actually ran (a new PTY was asked for). */
  launchedAt: number | null
  /** Why it failed, when known: the workspace's host did not do what was asked. */
  failure?: 'hostUnresponsive'
}

export const CLOUD_AGENT_RESTART_TIMEOUT_MS = 10_000
const restarts = new Map<string, CloudAgentRestartAttempt>()
const restartTimers = new Map<string, ReturnType<typeof setTimeout>>()

function stopRestartTimer(paneKey: string): void {
  const timer = restartTimers.get(paneKey)
  if (timer !== undefined) {
    clearTimeout(timer)
    restartTimers.delete(paneKey)
  }
}

/** The person clicked Restart (or Try again): queue it through `queue` and track the outcome. */
export function beginCloudAgentRestart(
  paneKey: string,
  args: { agent: HostAgentSignInAgent; resumable: boolean; ptyId: string },
  queue: () => void
): void {
  stopRestartTimer(paneKey)
  clearCloudRunningSignout(paneKey)
  restarts.set(paneKey, {
    phase: 'restarting',
    agent: args.agent,
    resumable: args.resumable,
    ptyId: args.ptyId,
    launchedAt: null
  })
  forcedRestarts.add(args.ptyId)
  restartTimers.set(
    paneKey,
    setTimeout(() => {
      restartTimers.delete(paneKey)
      const attempt = restarts.get(paneKey)
      if (attempt?.phase !== 'restarting') {
        return
      }
      forcedRestarts.delete(attempt.ptyId)
      // No proof of a relaunch (a new PTY in the pane, or the relaunched agent's status) in time.
      restarts.set(paneKey, { ...attempt, phase: 'failed' })
      notifyCloudRunningStrips()
    }, CLOUD_AGENT_RESTART_TIMEOUT_MS)
  )
  notifyCloudRunningStrips()
  try {
    queue()
  } catch (err) {
    console.warn('[orca-cloud] restart could not be queued:', err)
    failCloudAgentRestart(args.ptyId)
  }
}

function attemptKeyForPty(ptyId: string): string | null {
  for (const [paneKey, attempt] of restarts) {
    if (attempt.ptyId === ptyId && attempt.phase === 'restarting') {
      return paneKey
    }
  }
  return null
}

/** The pane's restart ran (the account-restart path asked for a new PTY in place of `ptyId`). */
export function noteCloudAgentRestartLaunched(ptyId: string, now = Date.now()): void {
  forcedRestarts.delete(ptyId)
  const paneKey = attemptKeyForPty(ptyId)
  const attempt = paneKey ? restarts.get(paneKey) : undefined
  if (paneKey && attempt) {
    restarts.set(paneKey, { ...attempt, launchedAt: now })
    notifyCloudRunningStrips()
  }
}

/** The pane's restart could not run (no startup to launch, or it threw). */
export function failCloudAgentRestart(
  ptyId: string,
  failure?: CloudAgentRestartAttempt['failure']
): void {
  forcedRestarts.delete(ptyId)
  const paneKey = attemptKeyForPty(ptyId)
  const attempt = paneKey ? restarts.get(paneKey) : undefined
  if (paneKey && attempt) {
    stopRestartTimer(paneKey)
    restarts.set(paneKey, { ...attempt, phase: 'failed', ...(failure ? { failure } : {}) })
    notifyCloudRunningStrips()
  }
}

/**
 * The pane's attempt, if any. `revision` (useCloudRunningSignoutVersion) is an input so the React
 * Compiler re-reads it when this module's memory changes.
 */
export function cloudAgentRestartAttempt(
  paneKey: string,
  _revision: number
): CloudAgentRestartAttempt | null {
  return restarts.get(paneKey) ?? null
}

/**
 * Settle a launched attempt once there is proof it relaunched: the pane's PTY changed or the
 * relaunched agent reported (the caller checks). Returns whether it settled. The strip
 * then follows the account: gone, or state 1 if the sign-in is still bad.
 */
export function settleCloudAgentRestart(paneKey: string): boolean {
  const attempt = restarts.get(paneKey)
  if (attempt?.phase !== 'restarting' || attempt.launchedAt === null) {
    return false
  }
  stopRestartTimer(paneKey)
  restarts.delete(paneKey)
  notifyCloudRunningStrips()
  return true
}

/** The person closed the "Couldn't restart" strip. */
export function dismissCloudAgentRestart(paneKey: string): void {
  stopRestartTimer(paneKey)
  const attempt = restarts.get(paneKey)
  if (attempt) {
    forcedRestarts.delete(attempt.ptyId)
    restarts.delete(paneKey)
  }
  clearCloudRunningSignout(paneKey)
  notifyCloudRunningStrips()
}

/** Tests only. */
export function resetCloudAgentRestartsForTest(): void {
  forcedRestarts.clear()
  for (const timer of restartTimers.values()) {
    clearTimeout(timer)
  }
  restartTimers.clear()
  restarts.clear()
}
