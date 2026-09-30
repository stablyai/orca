import { useEffect, useSyncExternalStore } from 'react'

const EMPTY: ReadonlySet<string> = new Set()

const openedByKey = new Map<string, ReadonlySet<string>>()
const listeners = new Set<() => void>()
const pollers = new Map<string, { subscribers: number; timer: number }>()

function keyOf(worktreePath: string, connectionId?: string | null): string {
  return `${connectionId ?? ''}|${worktreePath}`
}

/** Records which workspace-relative paths are opened for edit; unchanged sets keep their identity. */
export function publishPerforceOpenedFiles(
  worktreePath: string,
  connectionId: string | null | undefined,
  entries: readonly { path: string; group: string }[]
): void {
  const key = keyOf(worktreePath, connectionId)
  const next = new Set(entries.filter((e) => e.group === 'opened').map((e) => e.path))
  const previous = openedByKey.get(key)
  if (previous && previous.size === next.size && [...next].every((p) => previous.has(p))) {
    return
  }
  openedByKey.set(key, next)
  listeners.forEach((listener) => listener())
}

export async function refreshPerforceOpenedFiles(
  worktreePath: string,
  connectionId?: string | null
): Promise<void> {
  try {
    const status = await window.api.perforce.status({
      worktreePath,
      connectionId: connectionId ?? undefined
    })
    publishPerforceOpenedFiles(worktreePath, connectionId, status.entries)
  } catch {
    // Keep the last known state; the panel surfaces status errors.
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** True when the file is opened for edit; polls status while any tab is watching the workspace. */
export function usePerforceOpenedForEdit(
  worktreePath: string | null,
  connectionId: string | null | undefined,
  relativePath: string,
  enabled: boolean,
  isDirty: boolean,
  refreshIntervalSeconds: number
): boolean {
  const key = worktreePath ? keyOf(worktreePath, connectionId) : ''
  const opened = useSyncExternalStore(subscribe, () => openedByKey.get(key) ?? EMPTY)

  useEffect(() => {
    if (!enabled || !worktreePath) {
      return
    }
    let poller = pollers.get(key)
    if (!poller) {
      void refreshPerforceOpenedFiles(worktreePath, connectionId)
      poller = {
        subscribers: 0,
        timer:
          refreshIntervalSeconds > 0
            ? window.setInterval(
                () => void refreshPerforceOpenedFiles(worktreePath, connectionId),
                refreshIntervalSeconds * 1000
              )
            : 0
      }
      pollers.set(key, poller)
    }
    poller.subscribers += 1
    return () => {
      poller.subscribers -= 1
      if (poller.subscribers === 0) {
        if (poller.timer) {
          window.clearInterval(poller.timer)
        }
        pollers.delete(key)
      }
    }
  }, [enabled, worktreePath, connectionId, key, refreshIntervalSeconds])

  // Why: a save may have opened the file for edit; pick that up without waiting for the next poll.
  useEffect(() => {
    if (enabled && worktreePath && !isDirty) {
      void refreshPerforceOpenedFiles(worktreePath, connectionId)
    }
  }, [enabled, worktreePath, connectionId, isDirty])

  return enabled && opened.has(relativePath)
}
