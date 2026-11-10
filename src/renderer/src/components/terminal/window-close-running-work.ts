import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { Tab } from '../../../../shared/tab-types'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { collectTabPtyIds } from './running-terminal-close-guard'
import { probePtyRunningWork } from './pty-running-work-probe'
import { admitStructuredAgentSession } from '@/lib/agent-session/structured-agent-session-busy'
import { hasStructuredAgentSessionConversation } from '@/lib/agent-session/structured-agent-session-conversation'
import { shouldConfirmPinnedTabClose } from '@/store/pinned-tab-close-guard'

/** Bound quit probes to 1.5s; expiry prompts because an unanswered SSH host is unverifiable, never proof remote work stopped. */
export const WINDOW_CLOSE_PROBE_TIMEOUT_MS = 1_500

export type WindowCloseRunningWork =
  | { kind: 'none' }
  | { kind: 'running' }
  /** A remote execution host could not be observed, so its work may still be live. */
  | { kind: 'unverifiable' }
  | { kind: 'chat' }
  | { kind: 'pinned' }

function hasPinnedTabs(state: AppState): boolean {
  for (const tabs of Object.values(state.unifiedTabsByWorktree ?? {})) {
    if (tabs?.some((tab) => tab.isPinned === true)) {
      return true
    }
  }
  for (const tabs of Object.values(state.tabsByWorktree ?? {})) {
    if (tabs?.some((tab) => tab.isPinned === true)) {
      return true
    }
  }
  return false
}

function collectAllTerminalTabIds(state: AppState): string[] {
  const ids = new Set<string>()
  for (const tabs of Object.values(state.tabsByWorktree ?? {})) {
    for (const tab of tabs ?? []) {
      if (tab?.id) {
        ids.add(tab.id)
      }
    }
  }
  for (const tabs of Object.values(state.unifiedTabsByWorktree ?? {})) {
    for (const tab of tabs ?? []) {
      if (tab?.contentType === 'terminal') {
        if (tab.entityId) {
          ids.add(tab.entityId)
        }
        if (tab.id) {
          ids.add(tab.id)
        }
      }
    }
  }
  return [...ids]
}

async function checkAnyAgentSessionBusy(
  sessions: { workspaceId: string; tab: Tab }[]
): Promise<boolean> {
  if (sessions.length === 0) {
    return false
  }
  const probes = sessions.map(
    ({ workspaceId, tab }) =>
      new Promise<boolean>((resolve) => {
        let settled = false
        const finish = (busy: boolean): void => {
          if (!settled) {
            settled = true
            resolve(busy)
          }
        }
        const timer = setTimeout(() => finish(false), WINDOW_CLOSE_PROBE_TIMEOUT_MS)
        admitStructuredAgentSession(workspaceId, tab, 'window-close', (busy) => {
          clearTimeout(timer)
          finish(busy)
        }).catch(() => {
          clearTimeout(timer)
          finish(false)
        })
      })
  )
  const results = await Promise.all(probes)
  return results.some(Boolean)
}

/** Quit consents to local process termination (#524); warn for SSH relay work that may die after detach grace, including unverifiable hosts. Paired runtimes retain terminals independently (#29916), and local probe failures have no transport ambiguity. */
export async function assessWindowCloseRunningWork(params: {
  isQuitting: boolean
}): Promise<WindowCloseRunningWork> {
  const state = useAppStore.getState()
  const checkRunning = state.settings?.skipCloseTerminalWithRunningProcessConfirm !== true

  if (checkRunning) {
    const agentSessions: { workspaceId: string; tab: Tab }[] = []
    for (const [workspaceId, tabs] of Object.entries(state.unifiedTabsByWorktree ?? {})) {
      for (const tab of tabs ?? []) {
        if (tab?.contentType === 'agent-session') {
          agentSessions.push({ workspaceId, tab })
        }
      }
    }

    const terminalTabIds = collectAllTerminalTabIds(state)
    const ptyIds = new Set(terminalTabIds.flatMap((tabId) => collectTabPtyIds(state, tabId)))
    const candidatePtyIds = params.isQuitting
      ? [...ptyIds].filter((ptyId) => parseAppSshPtyId(ptyId) !== null)
      : [...ptyIds]

    const [anyChatBusy, probes] = await Promise.all([
      checkAnyAgentSessionBusy(agentSessions),
      candidatePtyIds.length > 0
        ? probePtyRunningWork(candidatePtyIds, {
            timeoutMs: WINDOW_CLOSE_PROBE_TIMEOUT_MS
          })
        : Promise.resolve([])
    ])

    const anyChatActive =
      anyChatBusy ||
      agentSessions.some(({ tab }) => hasStructuredAgentSessionConversation(tab, state))

    if (anyChatActive) {
      return { kind: 'chat' }
    }
    if (probes.some((probe) => probe.verdict === 'live')) {
      return { kind: 'running' }
    }
    if (probes.some((probe) => probe.remote && probe.verdict === 'unverifiable')) {
      return { kind: 'unverifiable' }
    }
  }

  if (shouldConfirmPinnedTabClose(state) && hasPinnedTabs(state)) {
    return { kind: 'pinned' }
  }

  return { kind: 'none' }
}
