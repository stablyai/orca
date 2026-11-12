import { useAppStore } from '@/store'
import {
  structuredAgentSessionTargetForHost,
  structuredAgentSessionTargetForTab
} from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
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

function hasRunningChat(): boolean {
  const state = useAppStore.getState()
  const legacyTargets = new Map<string, ReturnType<typeof structuredAgentSessionTargetForTab>>()
  for (const tabs of Object.values(state.unifiedTabsByWorktree)) {
    for (const tab of tabs ?? []) {
      if (tab.contentType !== 'agent-session') {
        continue
      }
      let target
      if (tab.executionHostId != null) {
        target = structuredAgentSessionTargetForHost(tab.executionHostId)
      } else {
        if (!legacyTargets.has(tab.worktreeId)) {
          legacyTargets.set(tab.worktreeId, structuredAgentSessionTargetForTab(state, tab))
        }
        target = legacyTargets.get(tab.worktreeId)
      }
      if (!target) {
        continue
      }
      const feed = getStructuredAgentSessionStatusFeed(target)
      const status = feed.getSnapshot().get(tab.entityId)?.status
      if (
        feed.getSessionObservation(tab.entityId) === 'live' &&
        (status === 'working' || status === 'attention')
      ) {
        return true
      }
    }
  }
  return false
}

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
  const probes = candidatePtyIds.length
    ? await probePtyRunningWork(candidatePtyIds, { timeoutMs: WINDOW_CLOSE_PROBE_TIMEOUT_MS })
    : []
  if (
    probes.some((probe) => probe.verdict === 'live') ||
    (!params.isQuitting && hasRunningChat())
  ) {
    return { kind: 'running' }
  }
  if (probes.some((probe) => probe.remote && probe.verdict === 'unverifiable')) {
    return { kind: 'unverifiable' }
  }
  return { kind: 'none' }
}
