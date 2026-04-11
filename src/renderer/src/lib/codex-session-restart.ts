import type { AppState } from '@/store'
import { useAppStore } from '@/store'

function normalizeProcessName(processName: string | null): string | null {
  if (!processName) {
    return null
  }
  return processName.toLowerCase().replace(/\.exe$/, '')
}

function isCodexForegroundProcess(processName: string | null): boolean {
  const normalized = normalizeProcessName(processName)
  if (!normalized) {
    return false
  }
  // Why: node-pty exposes the OS foreground process name, which can be the
  // shipped Codex binary name (for example "codex-aarch64-ap" on macOS)
  // instead of the shell command the user typed. Match on a Codex prefix so
  // account-switch restart prompts still appear for real Codex sessions.
  return normalized === 'codex' || normalized.startsWith('codex-')
}

async function getLiveCodexSessionPtyIds(state: AppState): Promise<string[]> {
  const tabs = Object.values(state.tabsByWorktree).flat()
  const checks = await Promise.all(
    tabs.map(async (tab) => {
      const ptyIds = state.ptyIdsByTabId[tab.id] ?? []
      if (ptyIds.length === 0) {
        return [] as string[]
      }

      // Why: Codex sessions are not reliably discoverable from tab labels.
      // Tabs keep fallback names until a CLI emits an OSC title, and Codex
      // does not always do that. The foreground PTY process is the stable
      // source of truth for whether this live tab is actually running Codex.
      const foregroundProcesses = await Promise.all(
        ptyIds.map((ptyId) => window.api.pty.getForegroundProcess(ptyId))
      )
      return ptyIds.filter((_, index) => isCodexForegroundProcess(foregroundProcesses[index]))
    })
  )

  return checks.flat()
}

export async function markLiveCodexSessionsForRestart(args: {
  previousAccountLabel: string
  nextAccountLabel: string
}): Promise<void> {
  const state = useAppStore.getState()
  const liveCodexSessionPtyIds = await getLiveCodexSessionPtyIds(state)
  if (liveCodexSessionPtyIds.length === 0) {
    return
  }

  useAppStore.getState().markCodexRestartNotices(
    liveCodexSessionPtyIds.map((ptyId) => ({
      ptyId,
      previousAccountLabel: args.previousAccountLabel,
      nextAccountLabel: args.nextAccountLabel
    }))
  )
}
