// Hook state read from the execution host while shown and Orca is visible; after an owner action, or
// the host's botsChanged (a call's run started or ended), every reader reads again.
import { useCallback, useSyncExternalStore } from 'react'
import { BOTS_CHANGED_EVENT } from '@/lib/bots-changed-window-event'
import { installWindowVisibilityTimeoutPoller } from '@/lib/window-activity/window-visibility-timeout-poller'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type {
  WebhookCallRow,
  WebhookSummary
} from '../../../../../shared/rpc-contract/webhooks-params'
import { callWebhookHost, webhookErrorCode, type WebhookErrorCode } from './webhook-host-client'

// The fallback for a change botsChanged doesn't cover, such as a call the cloud is still holding.
const REFRESH_MS = 30_000
// A host or cloud without webhooks won't gain them soon; ask far less often until it does.
const UNSUPPORTED_REFRESH_MS = 5 * 60_000
// Focus re-reads only a key due a read; an owner change waits at most this long after the last one.
const REREAD_COOLDOWN_MS = 1000
/** How often "last call 4 min ago" labels move on. */
export const WEBHOOK_AGO_TICK_MS = 30_000

export type WebhookRead<T> =
  | { status: 'loading' }
  /** refreshError: the latest read failed, so this is the last good answer. */
  | { status: 'ready'; value: T; refreshError: WebhookErrorCode | null }
  | { status: 'failed'; error: WebhookErrorCode }

const LOADING: WebhookRead<never> = { status: 'loading' }

// One read per key, shared by every card and row showing it, polled only while Orca is visible.
type Entry<T> = {
  read: WebhookRead<T>
  load: () => Promise<T>
  listeners: Set<() => void>
  // A host or cloud without webhooks is asked far less often.
  unsupported: boolean
  loading: boolean
  // A change arrived while a read was out; read once more after it.
  again: boolean
  poller: (() => void) & { refresh: () => void }
}

const readStores = new Set<{ changed: () => void }>()

/** After a rotate, secret change, pause, sample or delete: every shown card and row reads again. */
export function notifyWebhooksChanged(): void {
  readStores.forEach((store) => store.changed())
}

function nextRead<T>(previous: WebhookRead<T>, error: WebhookErrorCode): WebhookRead<T> {
  // A deleted hook is gone; any other failure keeps what was showing, with the reason beside it.
  return previous.status === 'ready' && error !== 'webhook_not_found'
    ? { ...previous, refreshError: error }
    : { status: 'failed', error }
}

/** A keyed store of one kind of host read; a key's inputs alone decide what it reads. With
 *  `pollWhile`, a key polls only while its answer needs it; owner actions and botsChanged still read. */
function hostReads<T>(
  pollWhile?: (value: T) => boolean
): (key: string, read: () => Promise<T>) => WebhookRead<T> {
  const entries = new Map<string, Entry<T>>()

  async function refresh(key: string, entry: Entry<T>): Promise<void> {
    entry.loading = true
    try {
      const value = await entry.load()
      entry.read = { status: 'ready', value, refreshError: null }
      entry.unsupported = false
    } catch (error) {
      const code = webhookErrorCode(error)
      entry.read = nextRead(entry.read, code)
      entry.unsupported = code === 'host_needs_update' || code === 'webhooks_unavailable'
    } finally {
      entry.loading = false
    }
    if (entries.get(key) !== entry) {
      return
    }
    entry.listeners.forEach((listener) => listener())
    if (entry.again) {
      entry.again = false
      setTimeout(() => entry.poller.refresh(), 0)
    }
  }

  function subscribe(key: string, load: () => Promise<T>, listener: () => void): () => void {
    let entry = entries.get(key)
    if (!entry) {
      const created: Entry<T> = {
        read: LOADING,
        load,
        listeners: new Set(),
        unsupported: false,
        loading: false,
        again: false,
        poller: Object.assign(() => {}, { refresh: () => {} })
      }
      if (entries.size === 0) {
        window.addEventListener(BOTS_CHANGED_EVENT, changed)
      }
      entries.set(key, created)
      created.poller = installWindowVisibilityTimeoutPoller({
        run: () => refresh(key, created),
        getDelayMs: () => {
          if (pollWhile && created.read.status !== 'loading') {
            if (created.read.status === 'failed' || !pollWhile(created.read.value)) {
              return null
            }
          }
          return created.unsupported ? UNSUPPORTED_REFRESH_MS : REFRESH_MS
        },
        cooldownMs: REREAD_COOLDOWN_MS
      })
      entry = created
    }
    const subscribed = entry
    subscribed.listeners.add(listener)
    return () => {
      subscribed.listeners.delete(listener)
      if (subscribed.listeners.size === 0) {
        subscribed.poller()
        entries.delete(key)
        if (entries.size === 0) {
          window.removeEventListener(BOTS_CHANGED_EVENT, changed)
        }
      }
    }
  }

  const changed = (): void =>
    entries.forEach((entry) => (entry.loading ? (entry.again = true) : entry.poller.refresh()))
  readStores.add({ changed })

  return function useHostRead(key, read) {
    return useSyncExternalStore(
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- SAFETY: the key names everything `read` reads, so a new key alone resubscribes.
      useCallback((listener: () => void) => subscribe(key, read, listener), [key]),
      () => entries.get(key)?.read ?? LOADING
    )
  }
}

const useSummaryRead = hostReads<WebhookSummary>()
const useHooksRead = hostReads<WebhookSummary[]>()
const useCallsRead = hostReads<WebhookCallRow[]>()
// The saved-automation card needs a hook only until it's live, so it stops polling then.
const usePendingSummaryRead = hostReads<WebhookSummary>((summary) => summary.state === 'pending')

function targetKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? 'local' : `env:${target.environmentId}`
}

/** One hook, for its chat card. */
export function useWebhookSummary(
  target: RuntimeClientTarget,
  hookId: string
): WebhookRead<WebhookSummary> {
  return useSummaryRead(`${targetKey(target)}|card|${hookId}`, () =>
    callWebhookHost(target, 'webhooks.card', { hookId })
  )
}

/** One hook, read again only while Orca Cloud hasn't taken it yet (or on a change); for a card
 *  that waits for the URL. */
export function usePendingWebhookSummary(
  target: RuntimeClientTarget,
  hookId: string
): WebhookRead<WebhookSummary> {
  return usePendingSummaryRead(`${targetKey(target)}|pending|${hookId}`, () =>
    callWebhookHost(target, 'webhooks.card', { hookId })
  )
}

/** A bot's hooks, for its Webhooks row. */
export function useBotWebhooks(
  target: RuntimeClientTarget,
  botId: string
): WebhookRead<WebhookSummary[]> {
  return useHooksRead(`${targetKey(target)}|list|${botId}`, () =>
    callWebhookHost(target, 'webhooks.list', { botId }).then((result) => result.hooks)
  )
}

/** A hook's recent calls; mounted only while its row is open. */
export function useWebhookCalls(
  target: RuntimeClientTarget,
  hookId: string
): WebhookRead<WebhookCallRow[]> {
  return useCallsRead(`${targetKey(target)}|calls|${hookId}`, () =>
    callWebhookHost(target, 'webhooks.calls', { hookId }).then((result) => result.calls)
  )
}
