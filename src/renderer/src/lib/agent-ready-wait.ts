import { classifyTitleActivity } from '@/lib/pane-agent-evidence'
import { isExpectedAgentProcess } from '../../../shared/agent-process-recognition'
import { isShellProcess } from './tui-agent-startup'
import { useAppStore } from '@/store'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'

// Prefer idle titles, then matching foreground process, then a non-shell child after grace; bound waiting so missing binaries cannot hang Use.
export type AgentReadyReason = 'title-idle' | 'foreground-match' | 'child-process' | 'timeout'

export type AgentReadyResult = {
  ready: boolean
  reason: AgentReadyReason
}

const DEFAULT_TIMEOUT_MS = 5000
const POLL_INTERVAL_MS = 120

function resolvePrimaryPtyId(tabId: string): string | null {
  const state = useAppStore.getState()
  const ptyIds = state.ptyIdsByTabId[tabId]
  return ptyIds?.[0] ?? null
}

function titleSuggestsReady(tabId: string): boolean {
  const state = useAppStore.getState()
  const paneTitles = state.runtimePaneTitlesByTabId[tabId]
  const titles: string[] = []
  if (paneTitles) {
    for (const title of Object.values(paneTitles)) {
      if (title) {
        titles.push(title)
      }
    }
  }
  // Before pane title handlers mount, use the persisted tab title; the small tab map is safe to scan at poll rate.
  if (titles.length === 0) {
    for (const tabs of Object.values(state.tabsByWorktree)) {
      const tab = tabs.find((t) => t.id === tabId)
      if (tab?.title) {
        titles.push(tab.title)
        break
      }
    }
  }
  return titles.some((title) => classifyTitleActivity(title) === 'idle')
}

/** Resolve readiness by idle title, matching process or non-shell child after grace. Timeout resolves ready:false; never rejects. */
export async function waitForAgentReady(
  tabId: string,
  expectedProcess: string,
  opts?: { timeoutMs?: number }
): Promise<AgentReadyResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  let attempt = 0

  while (Date.now() < deadline) {
    if (attempt > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, POLL_INTERVAL_MS))
    }
    attempt += 1

    if (titleSuggestsReady(tabId)) {
      return { ready: true, reason: 'title-idle' }
    }

    const ptyId = resolvePrimaryPtyId(tabId)
    if (!ptyId) {
      continue
    }

    try {
      const process = await inspectRuntimeTerminalProcess(ptyId)
      const foreground = process.foregroundProcess?.toLowerCase() ?? ''
      if (isExpectedAgentProcess(foreground, expectedProcess)) {
        return { ready: true, reason: 'foreground-match' }
      }

      // Non-shell children can be startup ls/git; delay this weakest signal and reject it while foreground remains a shell.
      if (attempt >= 4 && !isShellProcess(foreground)) {
        if (process.hasChildProcesses) {
          return { ready: true, reason: 'child-process' }
        }
      }
    } catch {
      // Swallow transient PTY inspection errors and keep polling.
    }
  }

  return { ready: false, reason: 'timeout' }
}
