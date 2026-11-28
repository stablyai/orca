// One person's tab list in a shared agent's Home, live from the agent's host. A watched stream: the
// host lays no pick of this device over it, holds nothing open and marks nothing read.
import { useEffect, useState } from 'react'
import { botTarget } from '@/lib/bot-hosts'
import { subscribeRuntimeRpc } from '@/runtime/rpc/subscriptions/runtime-rpc-subscribe'
import type { Bot } from '../../../../../shared/bot-types'
import { createSessionTabsTabDeltaDecoder } from '../../../../../shared/remote-runtime/session-graph/session-tabs-tab-delta'
import type { RuntimeMobileSessionClientTab } from '../../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { TabListPerson } from './viewed-tab-list'

export type PersonTabList = {
  tabs: readonly RuntimeMobileSessionClientTab[]
  activeTabId: string | null
}

export type PersonTabListRead =
  | { state: 'loading' }
  | { state: 'ready'; list: PersonTabList }
  | { state: 'failed' }

function frameOf(result: unknown): PersonTabList | null {
  if (typeof result !== 'object' || result === null) {
    return null
  }
  const type = Reflect.get(result, 'type')
  const tabs: unknown = Reflect.get(result, 'tabs')
  const activeTabId: unknown = Reflect.get(result, 'activeTabId')
  if ((type !== 'snapshot' && type !== 'updated') || !Array.isArray(tabs)) {
    return null
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host's session.tabs frame rows, this contract's wire shape.
    tabs: tabs as RuntimeMobileSessionClientTab[],
    activeTabId: typeof activeTabId === 'string' ? activeTabId : null
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
    const delta = createSessionTabsTabDeltaDecoder()
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
        onEvent: (result) => {
          const decoded = delta.decode(result)
          if (!decoded.ok) {
            // A delta with no frame before it: this read can't follow the list any more.
            settle({ state: 'failed' })
            return
          }
          const list = frameOf(decoded.result)
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
