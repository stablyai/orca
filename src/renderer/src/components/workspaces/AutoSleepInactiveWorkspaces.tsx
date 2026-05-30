import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { collectAutoSleepWorktreeIds } from '@/lib/auto-sleep-inactive-workspaces'
import { runSleepWorktrees } from '@/components/sidebar/sleep-worktree-flow'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'

const AUTO_SLEEP_SCAN_INTERVAL_MS = 60_000

function isRuntimeEnvironmentActive(): boolean {
  return Boolean(useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim())
}

function runAutoSleepScan(): void {
  if (isRuntimeEnvironmentActive()) {
    return
  }
  const state = useAppStore.getState()
  const worktreeIds = collectAutoSleepWorktreeIds(state)
  if (worktreeIds.length === 0) {
    return
  }
  void runSleepWorktrees(worktreeIds)
}

export function AutoSleepInactiveWorkspaces(): null {
  useEffect(() => {
    if (isRuntimeEnvironmentActive()) {
      return
    }
    return installWindowVisibilityInterval({
      run: runAutoSleepScan,
      intervalMs: AUTO_SLEEP_SCAN_INTERVAL_MS
    })
  }, [])

  return null
}
