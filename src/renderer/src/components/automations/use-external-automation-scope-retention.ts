import { useEffect, useMemo, useRef } from 'react'
import { ownerKey } from '../../../../shared/automation-owner-key'
import { externalAutomationProbeOwners } from './external-automation-scope-gating'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'

/** Retain probes only for visible hosts; cancel filtered/page-exit work so stale results cannot compete with requested Orca traffic. */
export function useExternalAutomationScopeRetention(
  entries: readonly AutomationHostCatalogEntry[]
): void {
  const owners = useMemo(() => externalAutomationProbeOwners(entries), [entries])
  // Compare scope signatures so equivalent rerenders cannot cancel and restart in-flight probes.
  const signature = useMemo(() => owners.map(ownerKey).join(' '), [owners])
  const ownersRef = useRef(owners)
  ownersRef.current = owners

  useEffect(() => {
    void window.api.automations.retainExternalScopes({ owners: ownersRef.current })
  }, [signature])

  useEffect(() => {
    return () => {
      void window.api.automations.retainExternalScopes({ owners: [] })
    }
  }, [])
}
