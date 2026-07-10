import type { EmulatorStreamInfo } from '@/components/emulator-pane/emulator-pane-types'

export const EMULATOR_MANUAL_LAUNCH_STARTED_EVENT = 'orca:emulator-launch-started'
export const EMULATOR_MANUAL_LAUNCH_FAILED_EVENT = 'orca:emulator-launch-failed'

const manualLaunchesByWorktree = new Set<string>()
const prelaunchedSessionsByWorktree = new Map<string, EmulatorStreamInfo>()

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
  prelaunchedSessionsByWorktree.set(worktreeId, info)
}

export function consumePrelaunchedSimulatorSession(worktreeId: string): EmulatorStreamInfo | null {
  const info = prelaunchedSessionsByWorktree.get(worktreeId) ?? null
  prelaunchedSessionsByWorktree.delete(worktreeId)
  return info
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
