import { useEffect, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

type Entry =
  | { status: 'pending' }
  | { status: 'ready'; src: string }
  | { status: 'failed'; at: number }

const FAILED_RETRY_MS = 5 * 60_000

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
let failureToastShown = false

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function settle(name: string, entry: Entry): void {
  entries.set(name, entry)
  for (const listener of listeners) {
    listener()
  }
}

/** Picking the AI style again is the user asking to retry, so forget failures and speak up again. */
export function retryFailedWorktreeAiIcons(): void {
  for (const [name, entry] of entries) {
    if (entry.status === 'failed') {
      entries.delete(name)
    }
  }
  failureToastShown = false
}

function request(name: string): void {
  const entry = entries.get(name)
  // Failures retry after a while; cards remount on scroll, so an immediate retry would respawn agents.
  if (entry && !(entry.status === 'failed' && Date.now() - entry.at > FAILED_RETRY_MS)) {
    return
  }
  entries.set(name, { status: 'pending' })
  void window.api.worktreeIcons
    .generate({ name })
    .then((result) => {
      if (result.success) {
        // A data URL renders the SVG as an image: its ids stay scoped and any script stays inert.
        settle(name, {
          status: 'ready',
          src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.svg)}`
        })
        return
      }
      settle(name, { status: 'failed', at: Date.now() })
      // One toast per attempt round: a misconfigured agent would otherwise fail once per card.
      if (!result.canceled && !failureToastShown) {
        failureToastShown = true
        toast.error(translate('sidebar.cardIcon.aiFailed', 'Could not generate workspace icons'), {
          description: result.error
        })
      }
    })
    .catch(() => settle(name, { status: 'failed', at: Date.now() }))
}

/** The AI icon for this workspace name as an image URL; null while generating or after a failure. */
export function useWorktreeAiIcon(name: string, enabled: boolean): string | null {
  useEffect(() => {
    if (enabled && name.trim()) {
      request(name.trim())
    }
  }, [enabled, name])
  return useSyncExternalStore(subscribe, () => {
    const entry = enabled ? entries.get(name.trim()) : undefined
    return entry?.status === 'ready' ? entry.src : null
  })
}
