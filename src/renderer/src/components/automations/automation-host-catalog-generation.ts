import { ownerKey } from '../../../../shared/automation-owner-key'
import type { StableAutomationAuthorityRef } from '../../../../shared/automation-owner-ref'
import {
  automationAuthorityCatalogKey,
  type AutomationHostCatalog,
  type AutomationHostCatalogEntry
} from './automation-host-catalog-types'

/**
 * Catalog generation, tracked *per authority*.
 *
 * It advances only when that authority's authoritative membership or
 * incarnation changes. Runtime connection status and SSH connection status feed
 * health, not this counter — otherwise one host's target bucket hydrating would
 * discard every other host's in-flight response and burn the retry cap.
 *
 * Callers must report the last known query support for an offline authority:
 * synthesising `legacy-unscoped` on a mere disconnect would drop the entries'
 * owner refs and read as an incarnation change.
 */

export type AutomationCatalogGenerationSync = {
  /** Authority keys whose catalog generation advanced. */
  advancedAuthorityKeys: readonly string[]
  /**
   * Hosts that stayed listed while their owner incarnation changed underneath —
   * a same-id SSH re-adoption or re-pair. Nothing else in the entry moves, so
   * this is the only signal that the rows already held answer for a host that no
   * longer exists.
   */
  reincarnatedStableKeys: readonly string[]
}

export type AutomationCatalogGenerationRegistry = {
  get: (authority: StableAutomationAuthorityRef) => number
  /** Applies a rebuilt catalog and reports what the caller has to invalidate. */
  sync: (catalog: AutomationHostCatalog) => AutomationCatalogGenerationSync
  reset: () => void
}

// Health is deliberately absent: only membership and incarnation belong here.
export function automationHostCatalogEntryFingerprint(entry: AutomationHostCatalogEntry): string {
  return `${entry.stableKey}|${entry.catalogState}|${entry.owner ? ownerKey(entry.owner) : '-'}`
}

function fingerprintByAuthority(catalog: AutomationHostCatalog): Map<string, string> {
  const parts = new Map<string, string[]>()
  for (const entry of catalog.entries) {
    const key = automationAuthorityCatalogKey(entry.stableRef.authority)
    const bucket = parts.get(key)
    if (bucket) {
      bucket.push(automationHostCatalogEntryFingerprint(entry))
    } else {
      parts.set(key, [automationHostCatalogEntryFingerprint(entry)])
    }
  }
  // Entries arrive in the deterministic catalog order, so the join is stable.
  return new Map([...parts].map(([key, values]) => [key, values.join('\n')]))
}

export function createAutomationCatalogGenerationRegistry(): AutomationCatalogGenerationRegistry {
  const generationByAuthorityKey = new Map<string, number>()
  const fingerprintByAuthorityKey = new Map<string, string>()
  const ownerKeyByStableKey = new Map<string, string>()

  /** Compared only where an owner exists: a disconnect can strip owner refs, and that is not a new incarnation. */
  const reincarnations = (catalog: AutomationHostCatalog): string[] => {
    const reincarnated: string[] = []
    const listed = new Set<string>()
    for (const entry of catalog.entries) {
      listed.add(entry.stableKey)
      if (!entry.owner) {
        continue
      }
      const next = ownerKey(entry.owner)
      const previous = ownerKeyByStableKey.get(entry.stableKey)
      if (previous !== undefined && previous !== next) {
        reincarnated.push(entry.stableKey)
      }
      ownerKeyByStableKey.set(entry.stableKey, next)
    }
    // Deleting during iteration is defined for Map; a visited key is never revisited.
    for (const stableKey of ownerKeyByStableKey.keys()) {
      if (!listed.has(stableKey)) {
        ownerKeyByStableKey.delete(stableKey)
      }
    }
    return reincarnated
  }

  const advance = (authorityKey: string, fingerprint: string): void => {
    fingerprintByAuthorityKey.set(authorityKey, fingerprint)
    generationByAuthorityKey.set(
      authorityKey,
      (generationByAuthorityKey.get(authorityKey) ?? 0) + 1
    )
  }

  return {
    get: (authority) => generationByAuthorityKey.get(automationAuthorityCatalogKey(authority)) ?? 0,
    sync: (catalog) => {
      const reincarnatedStableKeys = reincarnations(catalog)
      const next = fingerprintByAuthority(catalog)
      const advanced: string[] = []
      for (const [authorityKey, fingerprint] of next) {
        if (fingerprintByAuthorityKey.get(authorityKey) !== fingerprint) {
          advance(authorityKey, fingerprint)
          advanced.push(authorityKey)
        }
      }
      // Why: an authority that left the catalog must invalidate its captured requests too.
      for (const authorityKey of fingerprintByAuthorityKey.keys()) {
        if (!next.has(authorityKey) && fingerprintByAuthorityKey.get(authorityKey) !== '') {
          advance(authorityKey, '')
          advanced.push(authorityKey)
        }
      }
      return { advancedAuthorityKeys: advanced, reincarnatedStableKeys }
    },
    reset: () => {
      generationByAuthorityKey.clear()
      fingerprintByAuthorityKey.clear()
      ownerKeyByStableKey.clear()
    }
  }
}

const registry = createAutomationCatalogGenerationRegistry()

/** Generation Step 4's commit fence compares for the authority that owns the entry. */
export function getAuthorityCatalogGeneration(authority: StableAutomationAuthorityRef): number {
  return registry.get(authority)
}

export function syncAutomationHostCatalogGenerations(
  catalog: AutomationHostCatalog
): AutomationCatalogGenerationSync {
  return registry.sync(catalog)
}

export function resetAutomationHostCatalogGenerationsForTests(): void {
  registry.reset()
}
