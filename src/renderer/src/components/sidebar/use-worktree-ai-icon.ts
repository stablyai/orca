import { useEffect, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { createNonSecureContextUuid } from '../../../../shared/non-secure-context-uuid'
import { normalizeWorktreeIconName } from '../../../../shared/worktree/worktree-icon-generation'

type Entry =
  | { status: 'pending'; requestId: string }
  | { status: 'ready'; src: string }
  | { status: 'failed'; at: number }

const FAILED_RETRY_MS = 5 * 60_000

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
const consumers = new Map<string, number>()
let failureToastShown = false

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

function settle(name: string, entry: Entry): void {
  entries.set(name, entry)
  notify()
}

/** Picking the AI style again is the user asking to retry, so forget failures and speak up again. */
export function retryFailedWorktreeAiIcons(): void {
  failureToastShown = false
  for (const [name, entry] of entries) {
    if (entry.status === 'failed') {
      entries.delete(name)
      if (consumers.has(name)) {
        request(name)
      }
    }
  }
  notify()
}

/** Forget every saved icon, here and on disk, and redraw the mounted cards with the current recipe. */
export async function regenerateWorktreeAiIcons(): Promise<void> {
  await window.api.worktreeIcons.clearCache()
  failureToastShown = false
  for (const [name, entry] of entries) {
    // A running batch settles into the new recipe's cache anyway; respawning it would double the cost.
    if (entry.status !== 'pending') {
      entries.delete(name)
    }
  }
  for (const name of consumers.keys()) {
    request(name)
  }
  notify()
}

function request(name: string): void {
  const entry = entries.get(name)
  // Failures retry after a while; cards remount on scroll, so an immediate retry would respawn agents.
  if (entry && !(entry.status === 'failed' && Date.now() - entry.at > FAILED_RETRY_MS)) {
    return
  }
  const pending: Entry = { status: 'pending', requestId: createNonSecureContextUuid() }
  entries.set(name, pending)
  void window.api.worktreeIcons
    .generate({ name, requestId: pending.requestId })
    .then((result) => {
      if (entries.get(name) !== pending) {
        return
      }
      if (result.success) {
        // A data URL renders the SVG as an image: its ids stay scoped and any script stays inert.
        settle(name, {
          status: 'ready',
          src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.svg)}`
        })
        return
      }
      if (result.canceled) {
        entries.delete(name)
        notify()
        return
      }
      settle(name, { status: 'failed', at: Date.now() })
      // One toast per attempt round: a misconfigured agent would otherwise fail once per card.
      if (!failureToastShown) {
        failureToastShown = true
        toast.error(translate('sidebar.cardIcon.aiFailed', 'Could not generate workspace icons'), {
          description: result.error
        })
      }
    })
    .catch(() => {
      if (entries.get(name) === pending) {
        settle(name, { status: 'failed', at: Date.now() })
      }
    })
}

/** The AI icon for this workspace name as an image URL; null while generating or after a failure. */
export function useWorktreeAiIcon(name: string, enabled: boolean): string | null {
  const normalized = normalizeWorktreeIconName(name)
  useEffect(() => {
    if (!enabled || !normalized) {
      return
    }
    consumers.set(normalized, (consumers.get(normalized) ?? 0) + 1)
    request(normalized)
    return () => {
      const count = consumers.get(normalized)! - 1
      if (count > 0) {
        consumers.set(normalized, count)
        return
      }
      consumers.delete(normalized)
      const entry = entries.get(normalized)
      if (entry?.status === 'pending') {
        entries.delete(normalized)
        void window.api.worktreeIcons.cancel({ requestId: entry.requestId }).catch(() => {})
        notify()
      }
    }
  }, [enabled, normalized])
  return useSyncExternalStore(subscribe, () => {
    const entry = enabled ? entries.get(normalized) : undefined
    return entry?.status === 'ready' ? entry.src : null
  })
}
