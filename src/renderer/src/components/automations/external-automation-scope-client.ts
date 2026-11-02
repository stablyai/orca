/** Carry discovered ownership into every manager action; host-local manager IDs cannot identify a machine or safely reconstruct scope later. */

import type {
  ExternalAutomationAction,
  ExternalAutomationManager,
  ExternalAutomationProvider
} from '../../../../shared/automations-types'
import type { AutomationOwnerRef } from '../../../../shared/automation-owner-ref'
import { EXTERNAL_AUTOMATION_PROVIDERS } from '../../../../shared/external-automation-scope'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import { resolveExternalAutomationScopeGate } from './external-automation-scope-gating'

export type ExternalAutomationScope = {
  owner: AutomationOwnerRef
  provider: ExternalAutomationProvider
}

/** Pair manager and captured scope; openclaw:local collides on every host without SSH targets. */
export type ScopedExternalAutomationManager = {
  scope: ExternalAutomationScope
  manager: ExternalAutomationManager
}

/** A scope that answered with neither a manager nor a denial: it was not checked. */
export type ScopedExternalAutomationFailure = {
  scope: ExternalAutomationScope
  message: string
}

export type ScopedExternalAutomationManagers = {
  managers: readonly ScopedExternalAutomationManager[]
  /** Carries the owner, not just a key, so a failed host can be named to the user. */
  failures: readonly ScopedExternalAutomationFailure[]
}

const EMPTY_MANAGERS: ScopedExternalAutomationManagers = {
  managers: [],
  failures: []
}

/** Every `{host, provider}` pair the gate says may actually be probed. */
export function externalAutomationScopes(
  entries: readonly AutomationHostCatalogEntry[]
): ExternalAutomationScope[] {
  const scopes: ExternalAutomationScope[] = []
  for (const entry of entries) {
    const owner = resolveExternalAutomationScopeGate(entry).probeOwner
    if (!owner) {
      continue
    }
    for (const provider of EXTERNAL_AUTOMATION_PROVIDERS) {
      scopes.push({ owner, provider })
    }
  }
  return scopes
}

/** Takes scopes, not the catalog: the caller decides which hosts are in view. */
export async function listScopedExternalAutomationManagers(
  scopes: readonly ExternalAutomationScope[]
): Promise<ScopedExternalAutomationManagers> {
  if (scopes.length === 0) {
    return EMPTY_MANAGERS
  }
  const managers: ScopedExternalAutomationManager[] = []
  const failures: ScopedExternalAutomationFailure[] = []
  const results = await Promise.all(
    scopes.map(async (scope) => {
      try {
        return { scope, result: await window.api.automations.listExternalManagerForOwner(scope) }
      } catch (error) {
        // One provider's failure is a fact about that provider, never about the host.
        return {
          scope,
          result: {
            manager: null,
            error: error instanceof Error ? error.message : String(error),
            updatedAt: 0
          }
        }
      }
    })
  )
  for (const { scope, result } of results) {
    if (result.error) {
      failures.push({ scope, message: result.error })
    }
    if (!result.manager) {
      continue
    }
    managers.push({ scope, manager: result.manager })
  }
  return { managers, failures }
}

export async function runScopedExternalAutomationAction(
  scope: ExternalAutomationScope,
  jobId: string,
  action: ExternalAutomationAction
): Promise<void> {
  await window.api.automations.runExternalActionForOwner({ ...scope, jobId, action })
}
