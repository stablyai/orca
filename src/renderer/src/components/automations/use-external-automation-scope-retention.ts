import { useEffect, useMemo, useRef } from 'react'
import { ownerKey } from '../../../../shared/automation-owner-key'
import { externalAutomationProbeOwners } from './external-automation-scope-gating'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'

/**
 * Keeps the main-process probe pool working only on the hosts currently in view.
 *
 * Probes for a host the user has filtered away are cancelled rather than left to
 * finish: they would land after the view moved on, and they compete with the
 * Orca traffic the user is waiting on. Leaving the page retains nothing.
 */
export function useExternalAutomationScopeRetention(
  entries: readonly AutomationHostCatalogEntry[]
): void {
  const owners = useMemo(() => externalAutomationProbeOwners(entries), [entries])
  // Why: the signature gates the send so a re-rendered but identical scope set
  // does not cancel and restart probes that are already in flight.
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
