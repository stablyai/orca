import { useAppStore } from '@/store'
import {
  isProvenProcessExit,
  UNVERIFIED_PROCESS_EXIT_CODE
} from '../../../shared/terminal-exit-cause'

/** Missing wait status means no observed exit; inventing zero would falsely report a clean finish. */
export function runtimeWaitExitCode(wait: { exitCode?: number | null }): number {
  return wait.exitCode ?? UNVERIFIED_PROCESS_EXIT_CODE
}

/** Drop tab/PTY identity only on proven exit (as in pty-exit-hibernate); synthetic loss retires transport but preserves reconnect adoption and guards against orphan cleanup. */
export function settleTabPtyBinding(tabId: string, ptyId: string, code: number): void {
  const state = useAppStore.getState()
  if (isProvenProcessExit(code)) {
    state.clearTabPtyId(tabId, ptyId)
    return
  }
  state.markUnverifiedPtyLoss(tabId)
}
