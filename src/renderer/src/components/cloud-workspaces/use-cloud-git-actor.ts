// GH-ACTING-LINE: the git actor of the cloud workspace a worktree belongs to, shared by the people
// tooltip and the source control panel (one read per workspace). Re-read when Orca is focused,
// when a shared workspace's hour lapses (`until`), and every two minutes while mounted, since
// another member sending also changes it.
import { useEffect, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import type { CloudWorkspaceGitActor } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { sandboxIdForWorktree, useCloudWorkspaceIdentities } from './cloud-workspace-identity'

const REFRESH_MS = 2 * 60_000
const FRESH_MS = 15_000

type Entry = { value: CloudWorkspaceGitActor | null; at: number; inflight: Promise<void> | null }
const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach((listener) => listener())

/** Reads the actor now (deduped while one is in flight, and not again within FRESH_MS unless forced). */
export function refreshCloudGitActor(sandboxId: string, force = false): Promise<void> {
  const entry = entries.get(sandboxId) ?? { value: null, at: 0, inflight: null }
  entries.set(sandboxId, entry)
  if (entry.inflight || (!force && Date.now() - entry.at < FRESH_MS)) {
    return entry.inflight ?? Promise.resolve()
  }
  const read = window.api.cloudWorkspaces.gitActor
  if (!read) {
    return Promise.resolve()
  }
  entry.inflight = read(sandboxId)
    .then((result) => {
      // A failed read keeps the last answer; the next focus or tick asks again.
      if (result.ok) {
        entry.value = result.value
      }
    })
    .catch(() => undefined)
    .finally(() => {
      entry.at = Date.now()
      entry.inflight = null
      emit()
    })
  return entry.inflight
}

export function useCloudGitActor(worktreeId: string | null): CloudWorkspaceGitActor | null {
  const hostId = useAppStore((s) => s.activeWorkspaceExecutionHostId)
  const identities = useCloudWorkspaceIdentities()
  const sandboxId = worktreeId ? sandboxIdForWorktree({ id: worktreeId, hostId }, identities) : null
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => (sandboxId ? (entries.get(sandboxId)?.value ?? null) : null)
  )
  const until = value?.gitActor?.kind === 'member' ? value.gitActor.until : undefined
  useEffect(() => {
    if (!sandboxId) {
      return
    }
    void refreshCloudGitActor(sandboxId)
    const onFocus = (): void => void refreshCloudGitActor(sandboxId)
    window.addEventListener('focus', onFocus)
    // Paused while this window can't be seen; focus re-reads on the way back.
    const stopTicking = installWindowVisibilityInterval({
      run: () => void refreshCloudGitActor(sandboxId),
      intervalMs: REFRESH_MS
    })
    return () => {
      window.removeEventListener('focus', onFocus)
      stopTicking()
    }
  }, [sandboxId])
  useEffect(() => {
    if (!sandboxId || until === undefined) {
      return
    }
    // A second past the window, so the server already answers with the bot.
    const timer = setTimeout(
      () => void refreshCloudGitActor(sandboxId, true),
      Math.max(0, until - Date.now()) + 1_000
    )
    return () => clearTimeout(timer)
  }, [sandboxId, until])
  return value
}
