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

/** A kept binding passes its exit options on; an ordinary exit keeps the two-argument call. */
export function forwardAgentBackgroundExit(
  onExit: ((ptyId: string, code: number, options?: PtyExitOptions) => void) | undefined,
  ptyId: string,
  code: number,
  options?: PtyExitOptions
): void {
  if (options?.preserveRendererBinding) {
    onExit?.(ptyId, code, options)
  } else {
    onExit?.(ptyId, code)
  }
}

/** A background session's exit: settle its tab's binding, drop its launch config, tell the caller. */
export function settleAgentBackgroundExit(
  tabId: string | undefined,
  paneKey: string,
  onExit: Parameters<typeof forwardAgentBackgroundExit>[0],
  ptyId: string,
  code: number,
  options?: PtyExitOptions
): void {
  if (tabId) {
    settleTabPtyBinding(tabId, ptyId, code, options)
  }
  useAppStore.getState().clearAgentLaunchConfig(paneKey)
  forwardAgentBackgroundExit(onExit, ptyId, code, options)
}
