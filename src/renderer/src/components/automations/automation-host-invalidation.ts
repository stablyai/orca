/**
 * Turns `automationsChanged` events into cache invalidations.
 *
 * A scoped event invalidates its one entry; an older or unscoped event
 * invalidates every entry of *that authority only*, never the whole cache — one
 * chatty host must not evict the rows of every other host. Bursts collapse into
 * a single microtask so a run that writes definition, run, and usage events in
 * a row costs one refresh, and an old runtime's shared legacy request is issued
 * once for the whole burst.
 */

import { hostStableKey } from '../../../../shared/automation-owner-key'
import type {
  StableAutomationAuthorityRef,
  StableAutomationCatalogRef
} from '../../../../shared/automation-owner-ref'
import { automationAuthorityCatalogKey } from './automation-host-catalog-types'
import type { AutomationHostCache } from './automation-host-cache'

/** What changed on the host. Carried for diagnostics; every reason invalidates alike. */
export type AutomationAuthorityChangeReason = 'definition' | 'run' | 'usage'

/** The publisher payload plus the authority the subscriber resolved it from. */
export type AutomationAuthorityChangeEvent = {
  authority: StableAutomationAuthorityRef
  selector?: { kind: 'self' } | { kind: 'ssh'; targetId: string } | { kind: 'orphan' }
  reason?: AutomationAuthorityChangeReason
}

export type AutomationHostInvalidationOptions = {
  cache: AutomationHostCache
  /** Called once per coalesced burst with the entries that need refetching. */
  onInvalidated?: (stableKeys: readonly string[]) => void
  schedule?: (flush: () => void) => void
}

export type AutomationHostInvalidation = {
  handle: (event: AutomationAuthorityChangeEvent) => void
  flush: () => void
  pending: () => number
  dispose: () => void
}

function catalogRefFor(event: AutomationAuthorityChangeEvent): StableAutomationCatalogRef | null {
  if (!event.selector) {
    return null
  }
  if (event.selector.kind === 'ssh') {
    return {
      authority: event.authority,
      selector: { kind: 'ssh', targetId: event.selector.targetId }
    }
  }
  return event.selector.kind === 'orphan'
    ? { authority: event.authority, selector: { kind: 'orphan' } }
    : { authority: event.authority, selector: { kind: 'self' } }
}

export function createAutomationHostInvalidation(
  options: AutomationHostInvalidationOptions
): AutomationHostInvalidation {
  const schedule = options.schedule ?? queueMicrotask
  const scopedKeys = new Set<string>()
  const authorities = new Map<string, StableAutomationAuthorityRef>()
  let scheduled = false
  let disposed = false

  const flush = (): void => {
    scheduled = false
    if (disposed) {
      return
    }
    const invalidated = new Set<string>()
    for (const authority of authorities.values()) {
      for (const key of options.cache.invalidateAuthority(authority)) {
        invalidated.add(key)
      }
    }
    authorities.clear()
    for (const key of scopedKeys) {
      if (invalidated.has(key)) {
        continue
      }
      // A key with no entry has nothing stale to discard, but a create lands on
      // exactly such a host — dropping it here is how a new row never appears.
      // Report it either way and let the catalog decide whether it is fetchable.
      if (options.cache.getByKey(key)) {
        options.cache.invalidateKey(key)
      }
      invalidated.add(key)
    }
    scopedKeys.clear()
    if (invalidated.size > 0) {
      options.onInvalidated?.([...invalidated])
    }
  }

  return {
    handle: (event) => {
      if (disposed) {
        return
      }
      const ref = catalogRefFor(event)
      if (ref) {
        scopedKeys.add(hostStableKey(ref))
      } else {
        authorities.set(automationAuthorityCatalogKey(event.authority), event.authority)
      }
      if (!scheduled) {
        scheduled = true
        schedule(flush)
      }
    },
    flush,
    pending: () => scopedKeys.size + authorities.size,
    dispose: () => {
      disposed = true
      scopedKeys.clear()
      authorities.clear()
    }
  }
}
