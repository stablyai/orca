import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'

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
  // Why: remote session snapshots can populate PTY mappings before their tab
  // mirrors appear in tabsByWorktree. The PTY map is the liveness source used
  // by the terminal/session UI, so discover account-switch candidates there.
  const ptyIds = [...new Set(Object.values(state.ptyIdsByTabId).flat())]
  const checks = await Promise.all(
    ptyIds.map(async (ptyId) => {
      // Why: Codex sessions are not reliably discoverable from tab labels.
      // Tabs keep fallback names until a CLI emits an OSC title, and Codex
      // does not always do that. The foreground PTY process is the stable
      // source of truth for whether this live tab is actually running Codex.
      const foregroundProcess = await inspectRuntimeTerminalProcess(state.settings, ptyId).then(
        (inspection) => inspection.foregroundProcess,
        // Why: remote tab mirrors can briefly retain an expired handle. One
        // failed inspection must not suppress notices for every other session.
        () => null
      )
      return isCodexForegroundProcess(foregroundProcess) ? ptyId : null
    })
  )

  return checks.filter((ptyId): ptyId is string => ptyId !== null)
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
