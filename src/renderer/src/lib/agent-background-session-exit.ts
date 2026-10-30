import { useAppStore } from '@/store'
import type { PtyExitOptions } from '@/components/terminal-pane/pty-exit-delivery'
import {
  isProvenProcessExit,
  UNVERIFIED_PROCESS_EXIT_CODE
} from '../../../shared/terminal-exit-cause'

/** Missing wait status means no observed exit; inventing zero would falsely report a clean finish. */
export function runtimeWaitExitCode(wait: { exitCode?: number | null }): number {
  return wait.exitCode ?? UNVERIFIED_PROCESS_EXIT_CODE
}

/** Retained exits settle execution without dropping presentation; ordinary synthetic loss preserves reconnect adoption. */
export function settleTabPtyBinding(
  tabId: string,
  ptyId: string,
  code: number,
  options?: PtyExitOptions
): void {
  if (options?.preserveRendererBinding === true || options?.preserveRendererBinding === 'closing') {
    return
  }
  const state = useAppStore.getState()
  if (isProvenProcessExit(code)) {
    state.clearTabPtyId(tabId, ptyId)
    return
  }
  state.markUnverifiedPtyLoss(tabId)
}
