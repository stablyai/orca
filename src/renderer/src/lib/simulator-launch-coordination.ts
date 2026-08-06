import type { EmulatorStreamInfo } from '@/components/emulator-pane/emulator-pane-types'

export const EMULATOR_MANUAL_LAUNCH_STARTED_EVENT = 'orca:emulator-launch-started'
export const EMULATOR_MANUAL_LAUNCH_FAILED_EVENT = 'orca:emulator-launch-failed'

const manualLaunchesByWorktree = new Set<string>()
type PrelaunchedSimulatorSession = {
  info: EmulatorStreamInfo
  rememberedAt: number
}

// Why: prelaunch info is a short-lived handoff to the pane; if the pane never
// consumes it, stale stream URLs should not stick to removed worktree ids.
const PRELAUNCHED_SIMULATOR_SESSION_TTL_MS = 30_000
const PRELAUNCHED_SIMULATOR_SESSION_MAX = 16
const prelaunchedSessionsByWorktree = new Map<string, PrelaunchedSimulatorSession>()

function prunePrelaunchedSimulatorSessions(now = performance.now()): void {
  for (const [worktreeId, entry] of prelaunchedSessionsByWorktree) {
    if (now - entry.rememberedAt >= PRELAUNCHED_SIMULATOR_SESSION_TTL_MS) {
      prelaunchedSessionsByWorktree.delete(worktreeId)
    }
  }
  while (prelaunchedSessionsByWorktree.size > PRELAUNCHED_SIMULATOR_SESSION_MAX) {
    const oldest = prelaunchedSessionsByWorktree.keys().next().value
    if (oldest === undefined) {
      return
    }
    prelaunchedSessionsByWorktree.delete(oldest)
  }
}

export function beginManualSimulatorLaunch(worktreeId: string): void {
  manualLaunchesByWorktree.add(worktreeId)
}

export function finishManualSimulatorLaunch(worktreeId: string): void {
  manualLaunchesByWorktree.delete(worktreeId)
}

export function isManualSimulatorLaunchPending(worktreeId: string): boolean {
  return manualLaunchesByWorktree.has(worktreeId)
}

export function rememberPrelaunchedSimulatorSession(
  worktreeId: string,
  info: EmulatorStreamInfo | undefined
): void {
  if (!info?.streamUrl && !info?.wsUrl) {
    return
  }
  // Why: the TTL measures elapsed handoff age, so wall-clock corrections must
  // not resurrect stale stream metadata or discard a fresh handoff.
  const rememberedAt = performance.now()
  prelaunchedSessionsByWorktree.delete(worktreeId)
  prelaunchedSessionsByWorktree.set(worktreeId, {
    info,
    rememberedAt
  })
  prunePrelaunchedSimulatorSessions(rememberedAt)
}

export function consumePrelaunchedSimulatorSession(worktreeId: string): EmulatorStreamInfo | null {
  prunePrelaunchedSimulatorSessions()
  const info = prelaunchedSessionsByWorktree.get(worktreeId)?.info ?? null
  prelaunchedSessionsByWorktree.delete(worktreeId)
  return info
}

export function resetSimulatorLaunchCoordinationForTests(): void {
  manualLaunchesByWorktree.clear()
  prelaunchedSessionsByWorktree.clear()
}

export function getPrelaunchedSimulatorSessionCountForTests(): number {
  return prelaunchedSessionsByWorktree.size
}

export function dispatchManualSimulatorLaunchStarted(worktreeId: string): void {
  dispatchManualSimulatorLaunchEvent(EMULATOR_MANUAL_LAUNCH_STARTED_EVENT, { worktreeId })
}

export function dispatchManualSimulatorLaunchFailed(worktreeId: string, message: string): void {
  dispatchManualSimulatorLaunchEvent(EMULATOR_MANUAL_LAUNCH_FAILED_EVENT, {
    worktreeId,
    message
  })
}

function dispatchManualSimulatorLaunchEvent(type: string, detail: object): void {
  if (typeof window === 'undefined') {
    return
  }
  window.setTimeout(() => window.dispatchEvent(new CustomEvent(type, { detail })), 0)
}
