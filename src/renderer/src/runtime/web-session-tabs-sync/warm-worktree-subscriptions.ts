import { getWindowParkVisible, subscribeWindowParkVisibility } from '@/lib/window-park-visibility'
import { TERMINAL_WORKTREE_HOT_RETAIN_LIMIT } from '@/components/terminal-pane/terminal-hidden-view-parking'
import { lastVerifiedRuntimeStatus } from '../../../../shared/runtime-host-status'
import { useAppStore } from '../../store'
import type { AppState } from '../../store/types'
import { getRuntimeEnvironmentRevision } from '../runtime-environment-revision'
import type {
  ActiveSessionTabsSubscription,
  ActiveSubscriptionArgs,
  installActiveSessionTabsSubscription
} from './active-session-subscription'

// Why: match the worktrees whose terminals stay mounted (the selected one plus the hot-retained
// hidden set); a smaller pool resubscribed on every switch around a working set that never parks.
export const WARM_WORKTREE_SESSION_SUBSCRIPTION_LIMIT = 1 + TERMINAL_WORKTREE_HOT_RETAIN_LIMIT

type WarmEntry = {
  environmentId: string
  identity: string
  pairingRevision: number | undefined
  subscription: ActiveSessionTabsSubscription
}

function streamIdentity(
  connectionGeneration: number,
  runtimeId: string | null,
  pairingRevision: number | undefined
): string {
  return `${connectionGeneration}\u0000${runtimeId ?? ''}\u0000${pairingRevision ?? ''}`
}

/** The same identity use-web-session-tabs-sync.ts derives for the selected host. */
function currentStreamIdentity(state: AppState, environmentId: string): string {
  const status = state.runtimeStatusByEnvironmentId.get(environmentId)
  const environment = state.runtimeEnvironments.find(({ id }) => id === environmentId)
  return streamIdentity(
    status?.connectionGeneration ?? 0,
    lastVerifiedRuntimeStatus(status)?.runtimeId ?? null,
    environment ? (environment.pairingRevision ?? environment.createdAt) : undefined
  )
}

export type WarmWorktreeSessionSubscriptions = {
  /** Make this worktree's stream current, reusing a warm one installed for the same connection. */
  select: (args: ActiveSubscriptionArgs, runtimeId: string | null) => void
  /** The host answered again: restart only streams that ended, never a live one. */
  restartEnded: (environmentId: string) => void
  dispose: () => void
}

/**
 * Per-worktree `session.tabs.subscribe` streams, kept warm across worktree switches. Reinstalling
 * on every switch cost a subscribe round trip and a snapshot re-apply per switch on SSH hosts.
 */
export function createWarmWorktreeSessionSubscriptions(
  install: typeof installActiveSessionTabsSubscription
): WarmWorktreeSessionSubscriptions {
  // Map order is recency: the last entry is the selected worktree's stream.
  const entries = new Map<string, WarmEntry>()
  let selectedKey: string | null = null

  const drop = (key: string): void => {
    const entry = entries.get(key)
    entries.delete(key)
    entry?.subscription()
  }
  const dropUnselected = (): void => {
    for (const key of entries.keys()) {
      if (key !== selectedKey) {
        drop(key)
      }
    }
  }
  // Why: a hidden window parks every stream and a reveal resumes each one without stagger, so
  // warm streams would multiply the reveal's round trips.
  const unsubscribeVisibility = subscribeWindowParkVisibility(() => {
    if (!getWindowParkVisible()) {
      dropUnselected()
    }
  })

  // Why: a re-pair, removal or new runtime session of a host that is not selected never re-runs
  // the selection effect, so its warm streams would keep retrying a dead identity.
  const unsubscribeStore = useAppStore.subscribe((state, previous) => {
    if (
      state.runtimeEnvironments === previous.runtimeEnvironments &&
      state.runtimeStatusByEnvironmentId === previous.runtimeStatusByEnvironmentId
    ) {
      return
    }
    for (const [key, entry] of entries) {
      if (currentStreamIdentity(state, entry.environmentId) !== entry.identity) {
        drop(key)
      }
    }
  })

  return {
    select: (args, runtimeId) => {
      if (!args.workspaceSessionReady) {
        selectedKey = null
        dropUnselected()
        return
      }
      const environmentId = args.activeWorktreeRuntimeEnvironmentId?.trim()
      const identity = streamIdentity(
        args.activeWorktreeRuntimeConnectionGeneration,
        runtimeId,
        args.activeWorktreeRuntimePairingRevision
      )
      for (const [key, entry] of entries) {
        // A new runtime session or re-pair invalidates every stream cut from the old one.
        if (
          (entry.environmentId === environmentId && entry.identity !== identity) ||
          getRuntimeEnvironmentRevision(entry.environmentId) !== entry.pairingRevision
        ) {
          drop(key)
        }
      }
      const key =
        environmentId && args.activeWorktreeId
          ? `${environmentId}\u0000${args.activeWorktreeId}`
          : null
      selectedKey = key
      if (!key || !environmentId) {
        return
      }
      const warm = entries.get(key)
      if (warm) {
        entries.delete(key)
        entries.set(key, warm)
        warm.subscription.reconsiderSelected()
      } else {
        const subscription = install(args)
        if (!subscription) {
          return
        }
        entries.set(key, {
          environmentId,
          identity,
          pairingRevision: args.activeWorktreeRuntimePairingRevision,
          subscription
        })
      }
      for (const oldest of entries.keys()) {
        if (entries.size <= WARM_WORKTREE_SESSION_SUBSCRIPTION_LIMIT) {
          break
        }
        drop(oldest)
      }
    },
    restartEnded: (environmentId) => {
      for (const entry of entries.values()) {
        if (entry.environmentId === environmentId) {
          entry.subscription.restartEnded()
        }
      }
    },
    dispose: () => {
      unsubscribeStore()
      unsubscribeVisibility()
      selectedKey = null
      for (const key of entries.keys()) {
        drop(key)
      }
    }
  }
}
