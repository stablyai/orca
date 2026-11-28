// One person's tab list in a shared agent's Home, live from the agent's host. A watched stream: the
// host lays no pick of this device over it, holds nothing open and marks nothing read.
import { useEffect, useState } from 'react'
import { botTarget } from '@/lib/bot-hosts'
import { subscribeRuntimeRpc } from '@/runtime/rpc/subscriptions/runtime-rpc-subscribe'
import type { Bot } from '../../../../../shared/bot-types'
import type { RuntimeMobileSessionClientTab } from '../../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { TabListPerson } from './viewed-tab-list'

export type PersonTabList = {
  tabs: readonly RuntimeMobileSessionClientTab[]
  /** The tab active on that person's own side, which this read only shows. */
  theirActiveTabId: string | null
}

export type PersonTabListRead =
  | { state: 'loading' }
  | { state: 'ready'; list: PersonTabList }
  | { state: 'failed' }

function frameOf(result: unknown): PersonTabList | null {
  if (typeof result !== 'object' || result === null) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a session.tabs frame, this contract's wire shape; its kind and rows are checked below.
  const frame = result as Partial<Pick<RuntimeMobileSessionTabsResult, 'activeTabId'>> & {
    type?: unknown
    tabs?: RuntimeMobileSessionClientTab[]
  }
  if ((frame.type !== 'snapshot' && frame.type !== 'updated') || !Array.isArray(frame.tabs)) {
    return null
  }
  return {
    tabs: frame.tabs,
    theirActiveTabId: typeof frame.activeTabId === 'string' ? frame.activeTabId : null
  }
}

export function usePersonTabList(
  bot: Pick<Bot, 'hostId'>,
  homeKey: string,
  person: TabListPerson
): PersonTabListRead {
  const personKey = person === 'owner' ? 'owner' : person.accountId
  const [read, setRead] = useState<{ key: string; read: PersonTabListRead }>({
    key: '',
    read: { state: 'loading' }
  })
  // One target object per host, so this resubscribes only when whose list it reads changes.
  const target = botTarget(bot)
  const key = `${bot.hostId}\0${homeKey}\0${personKey}`
  useEffect(() => {
    let live = true
    let unsubscribe: (() => void) | null = null
    const settle = (next: PersonTabListRead): void => {
      if (live) {
        setRead({ key, read: next })
      }
    }
    void subscribeRuntimeRpc(
      target,
      'session.tabs.subscribe',
      {
        worktree: `id:${homeKey}`,
        person: personKey === 'owner' ? 'owner' : { accountId: personKey }
      },
      {
        // Full frames: a paired host's deltas are decoded in main, and this app's own sends none.
        onEvent: (result) => {
          const list = frameOf(result)
          if (list) {
            settle({ state: 'ready', list })
          }
        },
        onError: () => settle({ state: 'failed' }),
        onClose: () => settle({ state: 'failed' })
      }
    )
      .then((subscription) => {
        if (live) {
          unsubscribe = subscription.unsubscribe
        } else {
          subscription.unsubscribe()
        }
      })
      .catch(() => settle({ state: 'failed' }))
    return () => {
      live = false
      unsubscribe?.()
    }
  }, [target, key, homeKey, personKey])
  return read.key === key ? read.read : { state: 'loading' }
}
