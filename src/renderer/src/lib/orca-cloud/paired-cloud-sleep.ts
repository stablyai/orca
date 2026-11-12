// PAIRED-SLEEP (PAIRED-AWARE): Sleep on a paired cloud workspace (opened here, created elsewhere: a
// GitHub-only repo, another device, a teammate's, a link) must put its SANDBOX to sleep. This desktop
// has no runtime record of it, so the ordinary Sleep only closed panels here while the sandbox kept
// running and using sandbox hours. The control plane sleeps it, like Home's Sleep does.
import { useAppStore } from '@/store'
import { getWorktreeOnHostFromState } from '@/store/workspaces/selection/worktree-on-host-selector'
import { getCloudWorkspaceSnapshot } from './orca-cloud-workspace-store'
import { isCloudPrimaryRowNow, resolveCloudRowSandboxId } from './cloud-host-rows'
import { refreshCloudWorktreeBindings } from '@/components/cloud-workspaces/cloud-workspace-identity'

type Row = { id: string; hostId?: string | null; isMainWorktree?: boolean }

function rowFor(worktreeId: string): Row | null {
  return getWorktreeOnHostFromState(useAppStore.getState(), worktreeId, undefined) ?? null
}

/** A paired cloud workspace's own row: its Sleep must reach the sandbox through the control plane. */
export function isPairedCloudSleepTarget(worktreeId: string): boolean {
  if (getCloudWorkspaceSnapshot().ids.has(worktreeId)) {
    // This desktop's own sandbox: the ordinary Sleep suspends its VM.
    return false
  }
  const row = rowFor(worktreeId)
  return row !== null && isCloudPrimaryRowNow(row)
}

/** Sleeps each paired target's sandbox; returns the ids whose sandbox is still running. */
export async function sleepPairedCloudSandboxes(worktreeIds: readonly string[]): Promise<string[]> {
  const stillRunning: string[] = []
  const api = typeof window !== 'undefined' ? window.api?.cloudWorkspaces : undefined
  if (!api) {
    return stillRunning
  }
  // Sleep can run before any menu loaded the pairings (card action, shortcut): read them first.
  await refreshCloudWorktreeBindings().catch(() => undefined)
  for (const id of worktreeIds) {
    if (!isPairedCloudSleepTarget(id)) {
      continue
    }
    const row = rowFor(id)
    const sandboxId = row ? await resolveCloudRowSandboxId(row) : null
    const result = sandboxId ? await api.sleep(sandboxId).catch(() => null) : null
    if (!result?.ok) {
      stillRunning.push(id)
    }
  }
  return stillRunning
}
