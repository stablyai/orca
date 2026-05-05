import { detectAgentStatusFromTitle } from '../../../shared/agent-detection'
import { isShellProcess } from '@/lib/tui-agent-startup'
import { useAppStore } from '@/store'

// Why: agent CLIs vary widely in how they signal readiness. Title-based
// detection (OSC titles parsed by detectAgentStatusFromTitle) is the tightest
// signal we have — an agent that emits "✳ " or ". "/"* " prefixes has fully
// taken over the PTY. For agents that don't set titles, fall back to
// foreground-process equality (the launched binary is alive and owns the fg
// job), then finally to the presence of any non-shell child process. A hard
// timeout prevents the Use-button flow from hanging on a missing binary.
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
  // Why: fall back to the persisted tab.title when runtime pane titles haven't
  // been populated yet (e.g. the TerminalPane has not mounted a title handler
  // for this tab). Finding the tab by id walks every worktree, which is fine
  // at poll rates — the map is small.
  if (titles.length === 0) {
    for (const tabs of Object.values(state.tabsByWorktree)) {
      const tab = tabs.find((t) => t.id === tabId)
      if (tab?.title) {
        titles.push(tab.title)
        break
      }
    }
  }
  return titles.some((title) => detectAgentStatusFromTitle(title) === 'idle')
}

/**
 * Wait until the agent we launched on `tabId` is ready to accept typed input.
 *
 * Checks, in order of preference:
 *   1. Terminal title reports an idle agent status.
 *   2. Foreground process name matches `expectedProcess`.
 *   3. PTY has at least one non-shell child process (after a brief grace
 *      period so we don't accept the shell's own transient children).
 *
 * Resolves early on the first match, or after `timeoutMs` with
 * `{ ready: false, reason: 'timeout' }`. Never rejects.
 */
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
      const foreground = (await window.api.pty.getForegroundProcess(ptyId))?.toLowerCase() ?? ''
      if (
        foreground === expectedProcess ||
        foreground.startsWith(`${expectedProcess}.`) ||
        foreground.endsWith(`/${expectedProcess}`)
      ) {
        return { ready: true, reason: 'foreground-match' }
      }

      // Why: child-process check is the weakest signal (it fires for any
      // non-shell subprocess, including `ls` or `git`). Gate it behind a few
      // polls so the shell's own startup children don't spoof readiness on
      // cold-start. Never accept it while the foreground is still a shell.
      if (attempt >= 4 && !isShellProcess(foreground)) {
        const hasChildProcesses = await window.api.pty.hasChildProcesses(ptyId)
        if (hasChildProcesses) {
          return { ready: true, reason: 'child-process' }
        }
      }
    } catch {
      // Swallow transient PTY inspection errors and keep polling.
    }
  }

  return { ready: false, reason: 'timeout' }
}
