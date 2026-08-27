/**
 * The renderer's scoped external-manager surface.
 *
 * Every call names the owner the host was captured under, so a manager ID —
 * which is only unique inside one host — can never route a mutation to a
 * different machine. The owner is recorded when a manager is discovered and
 * replayed on every later action, rather than re-derived from the manager's own
 * target at action time.
 */

import type {
  ExternalAutomationAction,
  ExternalAutomationJob,
  ExternalAutomationManager,
  ExternalAutomationProvider,
  ExternalAutomationRun
} from '../../../../shared/automations-types'
import type { AutomationOwnerRef } from '../../../../shared/automation-owner-ref'
import {
  EXTERNAL_AUTOMATION_PROVIDERS,
  type ScopedExternalManagerMutationFields
} from '../../../../shared/external-automation-scope'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import { resolveExternalAutomationScopeGate } from './external-automation-scope-gating'

export type ExternalAutomationScope = {
  owner: AutomationOwnerRef
  provider: ExternalAutomationProvider
}

/**
 * A discovered manager still carrying the scope it was listed under.
 *
 * Why paired rather than looked up: a manager ID is `hermes:local` on every host
 * that has no SSH target, so it does not name an authority. Recovering the scope
 * from the ID would collide for exactly the hosts a scope is meant to separate.
 */
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

/**
 * The desktop host that owns a repo's external managers. Null when no owner
 * could be captured for it, which disables creation rather than defaulting one.
 */
export function desktopExternalAutomationOwner(
  entries: readonly AutomationHostCatalogEntry[],
  connectionId: string | null
): AutomationOwnerRef | null {
  for (const entry of entries) {
    if (entry.stableRef.authority.kind !== 'desktop' || !entry.owner) {
      continue
    }
    const selector = entry.stableRef.selector
    const matches =
      connectionId === null
        ? selector.kind === 'self'
        : selector.kind === 'ssh' && selector.targetId === connectionId
    if (matches) {
      return entry.owner
    }
  }
  return null
}

export async function createScopedExternalAutomation(
  scope: ExternalAutomationScope,
  fields: ScopedExternalManagerMutationFields
): Promise<void> {
  await window.api.automations.createExternalForOwner({ ...scope, ...fields })
}

export async function updateScopedExternalAutomation(
  scope: ExternalAutomationScope,
  jobId: string,
  fields: ScopedExternalManagerMutationFields
): Promise<void> {
  await window.api.automations.updateExternalForOwner({ ...scope, ...fields, jobId })
}

export async function runScopedExternalAutomationAction(
  scope: ExternalAutomationScope,
  jobId: string,
  action: ExternalAutomationAction
): Promise<void> {
  await window.api.automations.runExternalActionForOwner({ ...scope, jobId, action })
}

export type ScopedExternalAutomationRunsPage = {
  runs: readonly ExternalAutomationRun[]
  totalCount: number
}

export async function listScopedExternalAutomationRuns(
  scope: ExternalAutomationScope,
  job: ExternalAutomationJob,
  page: number,
  pageSize: number
): Promise<ScopedExternalAutomationRunsPage> {
  const result = await window.api.automations.listExternalRunsForOwner({
    ...scope,
    jobId: job.id,
    // The engine pages from one; the table's page index is zero-based.
    page: page + 1,
    pageSize
  })
  return { runs: result.runs, totalCount: result.total }
}
