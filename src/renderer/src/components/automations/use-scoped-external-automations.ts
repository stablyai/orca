import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ExternalAutomationAction } from '../../../../shared/automations-types'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import {
  externalAutomationScopes,
  listScopedExternalAutomationManagers,
  runScopedExternalAutomationAction,
  type ExternalAutomationScope,
  type ScopedExternalAutomationFailure,
  type ScopedExternalAutomationManager
} from './external-automation-scope-client'
import { externalAutomationScopeKey } from './external-automation-scope-keys'
import { useExternalAutomationScopeRetention } from './use-external-automation-scope-retention'

/**
 * External managers for the hosts currently in view, and the scope each one was
 * discovered under.
 *
 * A manager ID is unique only inside one host — `openclaw:local` names no
 * authority at all — so every call here takes the scope its row was discovered
 * under rather than a manager to look one up from. There is no lookup to miss
 * and no host to guess at.
 */

export type ScopedExternalAutomationsInput = {
  /** The hosts in view. Only these are probed, and only these are retained. */
  scopeEntries: readonly AutomationHostCatalogEntry[]
}

export type ScopedExternalAutomationsView = {
  managers: readonly ScopedExternalAutomationManager[]
  /** Scopes that answered with neither a manager nor a denial. */
  failures: readonly ScopedExternalAutomationFailure[]
  /** Reloads every in-view scope; safe to call from the page's refresh path. */
  reload: () => Promise<void>
  runExternalAction: (
    scope: ExternalAutomationScope,
    jobId: string,
    action: ExternalAutomationAction
  ) => Promise<void>
}

const EMPTY_VIEW = {
  managers: [] as readonly ScopedExternalAutomationManager[],
  failures: [] as readonly ScopedExternalAutomationFailure[]
}

export function useScopedExternalAutomations({
  scopeEntries
}: ScopedExternalAutomationsInput): ScopedExternalAutomationsView {
  const [result, setResult] = useState(EMPTY_VIEW)
  useExternalAutomationScopeRetention(scopeEntries)

  const scopes = useMemo(() => externalAutomationScopes(scopeEntries), [scopeEntries])
  const signature = useMemo(
    () => scopes.map((scope) => externalAutomationScopeKey(scope)).join(' '),
    [scopes]
  )
  const scopesRef = useRef(scopes)
  scopesRef.current = scopes
  const signatureRef = useRef(signature)
  signatureRef.current = signature
  // Seeded with the mount signature: the page's own mount refresh issues the
  // first load, and this must not duplicate it.
  const loadedSignatureRef = useRef(signature)
  // A selection change can overtake the probe it replaced; only the newest wins.
  const loadTokenRef = useRef(0)

  const reload = useCallback(async (): Promise<void> => {
    const token = ++loadTokenRef.current
    loadedSignatureRef.current = signatureRef.current
    const next = await listScopedExternalAutomationManagers(scopesRef.current)
    if (token !== loadTokenRef.current) {
      return
    }
    setResult({ managers: next.managers, failures: next.failures })
  }, [])

  // The scope set is the query: when it changes, what is on screen is another host's answer.
  useEffect(() => {
    if (loadedSignatureRef.current === signature) {
      return
    }
    // The old host's managers are not evidence about the new one, so they go now
    // rather than when its probe answers.
    setResult(EMPTY_VIEW)
    void reload().catch(() => undefined)
  }, [signature, reload])

  return {
    managers: result.managers,
    failures: result.failures,
    reload,
    runExternalAction: useCallback(
      async (scope, jobId, action) => await runScopedExternalAutomationAction(scope, jobId, action),
      []
    )
  }
}
