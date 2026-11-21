import {
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import {
  botChangeConcerns,
  readBotChangeScopeWithItems,
  type BotChangeInterest,
  type BotChangeScope
} from '../../../shared/bots/bot-change-scope'

/** Fans a host's `botsChanged` out to whichever bot views are open; `detail.hostId` names the host,
 *  `detail.scope` the bots and kinds of change it covers (absent from an older host: everything). */
export const BOTS_CHANGED_EVENT = 'orca:bots-changed'

export type BotsChangedDetail = { hostId: ExecutionHostId; scope?: BotChangeScope }

export function emitBotsChangedWindowEvent(hostId: ExecutionHostId, scope?: BotChangeScope): void {
  window.dispatchEvent(
    new CustomEvent<BotsChangedDetail>(BOTS_CHANGED_EVENT, {
      detail: { hostId, ...(scope ? { scope } : {}) }
    })
  )
}

/**
 * Hears each host's bots change. With `hostId`, only that host's changes call `listener`, so a
 * view of one bot or one host never re-reads on another host's change; with `interest`, only a
 * change to that bot (or any bot, for a host-wide view) of a kind it shows. `listener` gets the
 * notice's scope too (undefined from an older host).
 */
export function onBotsChanged(
  listener: (hostId: ExecutionHostId, scope: BotChangeScope | undefined) => void,
  hostId?: ExecutionHostId,
  interest?: BotChangeInterest
): () => void {
  const handle = (event: Event): void => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : undefined
    const changed =
      detail &&
      typeof detail === 'object' &&
      'hostId' in detail &&
      typeof detail.hostId === 'string'
        ? normalizeExecutionHostId(detail.hostId)
        : null
    if (!changed || (hostId !== undefined && changed !== hostId)) {
      return
    }
    const scope =
      detail && typeof detail === 'object' && 'scope' in detail
        ? readBotChangeScopeWithItems(detail.scope)
        : undefined
    if (!interest || botChangeConcerns(scope, interest)) {
      listener(changed, scope)
    }
  }
  window.addEventListener(BOTS_CHANGED_EVENT, handle)
  return () => window.removeEventListener(BOTS_CHANGED_EVENT, handle)
}
