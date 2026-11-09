import { useAppStore } from '@/store'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { collectTabPtyIds } from './running-terminal-close-guard'
import { probePtyRunningWork } from './pty-running-work-probe'

/** Bound quit probes to 1.5s; expiry prompts because an unanswered SSH host is unverifiable, never proof remote work stopped. */
export const WINDOW_CLOSE_PROBE_TIMEOUT_MS = 1_500

export type WindowCloseRunningWork =
  | { kind: 'none' }
  | { kind: 'running' }
  /** A remote execution host could not be observed, so its work may still be live. */
  | { kind: 'unverifiable' }

/** Quit consents to local process termination (#524); warn for SSH relay work that may die after detach grace, including unverifiable hosts. Paired runtimes retain terminals independently (#29916), and local probe failures have no transport ambiguity. */
export async function assessWindowCloseRunningWork(params: {
  isQuitting: boolean
}): Promise<WindowCloseRunningWork> {
  const state = useAppStore.getState()
  const ptyIds = new Set(
    Object.values(state.tabsByWorktree)
      .flatMap((worktreeTabs) => worktreeTabs ?? [])
      .flatMap((tab) => collectTabPtyIds(state, tab.id))
  )
  const candidatePtyIds = params.isQuitting
    ? [...ptyIds].filter((ptyId) => parseAppSshPtyId(ptyId) !== null)
    : [...ptyIds]
  if (candidatePtyIds.length === 0) {
    return { kind: 'none' }
  }

  const probes = await probePtyRunningWork(candidatePtyIds, {
    timeoutMs: WINDOW_CLOSE_PROBE_TIMEOUT_MS
  })
  if (probes.some((probe) => probe.verdict === 'live')) {
    return { kind: 'running' }
  }
  if (probes.some((probe) => probe.remote && probe.verdict === 'unverifiable')) {
    return { kind: 'unverifiable' }
  }
  return { kind: 'none' }
}
