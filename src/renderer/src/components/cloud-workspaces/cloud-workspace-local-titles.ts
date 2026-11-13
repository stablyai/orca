import { useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'

/**
 * Names this computer gave its own cloud workspaces, by control-plane workspace id. The local VM
 * record links the two (its id is the workspace's `orca-…` id); the name is the sidebar's.
 */
export function useLocalCloudWorkspaceNames(): ReadonlyMap<string, string> {
  const pairs = useAppStore((state) =>
    Object.values(state.ephemeralVmRuntimesByWorkspaceId ?? {})
      .map((runtime) => {
        const name = findWorktreeById(state, runtime.workspaceId)?.displayName
        return name ? `${runtime.id}\u0000${name}` : null
      })
      .filter((entry): entry is string => entry !== null)
      .join('\u0001')
  )
  return useMemo(
    () =>
      new Map(
        pairs
          ? pairs.split('\u0001').map((entry) => {
              const cut = entry.indexOf('\u0000')
              return [entry.slice(0, cut), entry.slice(cut + 1)] as const
            })
          : []
      ),
    [pairs]
  )
}

/**
 * A workspace started without a title shows its repo in the team list ("Hello-World" for
 * "ra12-asleep", RA-13). Use the name this computer gave it; the repo stays on the second line.
 */
export function withLocalTitles(
  workspaces: readonly CloudWorkspace[],
  names: ReadonlyMap<string, string>
): CloudWorkspace[] {
  return workspaces.map((w) => {
    const name = w.title ? null : names.get(w.workspaceId)
    return name ? { ...w, title: name } : w
  })
}

/** Teammates see the name too: save it as the workspace's title once, for workspaces this user owns. */
export function useBackfillLocalTitles(
  workspaces: readonly CloudWorkspace[],
  names: ReadonlyMap<string, string>
): void {
  const done = useRef(new Set<string>())
  useEffect(() => {
    const api = window.api?.cloudWorkspaces
    if (!api) {
      return
    }
    for (const w of workspaces) {
      const name = names.get(w.workspaceId)
      if (w.title || !name || w.access !== 'owner' || done.current.has(w.id)) {
        continue
      }
      done.current.add(w.id)
      // Best effort: the list already shows the name; a failed save only means teammates don't yet.
      void api.patch(w.id, { title: name }).catch(() => {})
    }
  }, [workspaces, names])
}

const NONE: readonly CloudWorkspace[] = []

/**
 * What the cloud workspace list shows: a workspace being deleted (or gone) is not something to open
 * or manage, so it is left out; untitled ones this computer started read by its name, not the repo.
 */
export function useListedCloudWorkspaces(
  workspaces: readonly CloudWorkspace[] | null
): CloudWorkspace[] {
  const listed = useMemo(
    () => (workspaces ?? NONE).filter((w) => w.status !== 'destroying' && w.status !== 'destroyed'),
    [workspaces]
  )
  const localNames = useLocalCloudWorkspaceNames()
  useBackfillLocalTitles(listed, localNames)
  return useMemo(() => withLocalTitles(listed, localNames), [listed, localNames])
}
