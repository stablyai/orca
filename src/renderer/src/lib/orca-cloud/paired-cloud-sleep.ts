// PAIRED-SLEEP (PAIRED-AWARE): Sleep on a paired cloud workspace (opened here, created elsewhere: a
// GitHub-only repo, another device, a teammate's, a link) must put its SANDBOX to sleep. This desktop
// has no runtime record of it, so the ordinary Sleep only closed panels here while the sandbox kept
// running and using sandbox hours. The control plane sleeps it, like Home's Sleep does.
import { useAppStore } from '@/store'
import { getWorktreeOnHostFromState } from '@/store/workspaces/selection/worktree-on-host-selector'
import { getCloudWorkspaceSnapshot } from './orca-cloud-workspace-store'
import { isCloudPrimaryRowNow, resolveCloudRowSandboxId } from './cloud-host-rows'
import { refreshCloudWorktreeBindings } from '@/components/cloud-workspaces/cloud-workspace-identity'
import { notePairedCloudSlept } from './paired-cloud-wake'

type Row = { id: string; hostId?: string | null; isMainWorktree?: boolean }

function rowFor(worktreeId: string): Row | null {
  return getWorktreeOnHostFromState(useAppStore.getState(), worktreeId, undefined) ?? null
}

/**
 * A paired cloud workspace's own row: its Sleep must reach the sandbox through the control plane.
 * SHARED-MEMBER-SLEEP-HANG: the row the paired registry names (a teammate's shared workspace is its
 * linked worktree since #690, not the main checkout); a main checkout still counts before it loads.
 */
export function isPairedCloudSleepTarget(worktreeId: string): boolean {
  const snapshot = getCloudWorkspaceSnapshot()
  if (snapshot.ids.has(worktreeId)) {
    // This desktop's own sandbox: the ordinary Sleep suspends its VM.
    return false
  }
  if (worktreeId in snapshot.paired) {
    return true
  }
  const row = rowFor(worktreeId)
  return row !== null && isCloudPrimaryRowNow(row)
}

/** The control plane refused the sleep: only the owner or a team admin may sleep it (404). */
function isSleepRefused(result: { ok: false; error: string; status?: number }): boolean {
  return result.error === 'not_found' || result.error === 'forbidden' || result.status === 403
}

export type PairedSleepOutcome = {
  /** Still running: not slept (refused, failed, or no sandbox found for the row). */
  stillRunning: string[]
  /** Of those, refused because this account may not sleep it (a member on a teammate's workspace). */
  refused: string[]
}

/** Sleeps each paired target's sandbox; every target ends slept, still running or refused. */
export async function sleepPairedCloudSandboxes(
  worktreeIds: readonly string[]
): Promise<PairedSleepOutcome> {
  const outcome: PairedSleepOutcome = { stillRunning: [], refused: [] }
  const api = typeof window !== 'undefined' ? window.api?.cloudWorkspaces : undefined
  if (!api) {
    return outcome
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
      // Never left "going to sleep": not slept here is still running (and says why).
      outcome.stillRunning.push(id)
      if (result && isSleepRefused(result)) {
        outcome.refused.push(id)
      }
    } else {
      // The row says Asleep (not Active) now, and opening it wakes it (n38 GATE).
      await notePairedCloudSlept(id)
    }
  }
  return outcome
}
