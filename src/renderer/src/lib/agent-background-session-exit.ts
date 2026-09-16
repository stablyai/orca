import { useAppStore } from '@/store'
import {
  isProvenProcessExit,
  UNVERIFIED_PROCESS_EXIT_CODE
} from '../../../shared/terminal-exit-cause'

/**
 * The code a runtime `terminal.wait` actually reported.
 *
 * Why not `?? 0`: a wait that answers without a status observed nothing, and a
 * fabricated zero would be read downstream as a clean finish.
 */
export function runtimeWaitExitCode(wait: { exitCode?: number | null }): number {
  return wait.exitCode ?? UNVERIFIED_PROCESS_EXIT_CODE
}

/**
 * Settle a background agent tab's PTY binding when its session ends.
 *
 * Mirrors the rule the mounted panes follow (pty-exit-hibernate.ts): only a
 * proven exit drops the tab↔PTY identity. A synthetic loss sentinel retires the
 * transport alone, so the binding stays for reconnect to adopt and the tab is
 * marked so orphan cleanup cannot sweep an agent that may still be running.
 */
export function settleTabPtyBinding(tabId: string, ptyId: string, code: number): void {
  const state = useAppStore.getState()
  if (isProvenProcessExit(code)) {
    state.clearTabPtyId(tabId, ptyId)
    return
  }
  state.markUnverifiedPtyLoss(tabId)
}
