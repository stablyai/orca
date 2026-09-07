/**
 * Where a new automation is created, stated explicitly.
 *
 * Creation never infers a host. A concrete host filter constrains the
 * destination; under All hosts the active workspace's host may pre-fill it, but
 * only when that host resolves to a catalog entry with a real executable owner.
 * Anything less — an orphan bucket, an unhydrated or ghost host, no selection
 * at all — asks the user instead of picking for them, because a silent default
 * here creates a scheduled job on a machine nobody chose.
 *
 * The destination is re-resolved immediately before submit so a host that
 * changed incarnation while the form was open fails closed with the form
 * intact, rather than landing the record on a re-registered target.
 */

import type {
  AutomationAuthorityRef,
  AutomationOwnerRef
} from '../../../../shared/automation-owner-ref'
import type { AutomationDestination } from '../../../../shared/automation-owner-precondition'
import { hostStableKey, isSameAutomationOwner } from '../../../../shared/automation-owner-key'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type {
  AutomationCatalogHydrationEvidence,
  AutomationHostCatalogEntry
} from './automation-host-catalog-types'
import { automationAuthorityCatalogKey } from './automation-host-catalog-types'
import {
  repoConnectionIdIn,
  type AutomationAuthorityRepoTables
} from './automation-authority-identity'
import { automationHostRecoveryActions } from './automation-host-status-descriptors'

export type AutomationCreateDestinationChoiceReason =
  /** No host is selected and nothing may be assumed. */
  | 'unselected'
  /** The selection is the authority's orphan bucket, which cannot own new records. */
  | 'orphan'
  /** The host is known but has no executable owner yet: ghost, unhydrated, or legacy. */
  | 'unavailable'

export type AutomationCreateDestination = {
  authority: AutomationAuthorityRef
  destination: AutomationDestination
  /** The entry the user will see named on the form before submit. */
  entry: AutomationHostCatalogEntry
}

export type AutomationCreateDestinationResolution =
  | ({ status: 'ready' } & AutomationCreateDestination)
  | { status: 'choice-required'; reason: AutomationCreateDestinationChoiceReason }

/**
 * The one create-eligibility predicate: an executable owner AND the scoped
 * query contract. A view-only entry (degraded `querySupport`) must not accept
 * a create it could not list or edit back afterwards, so every surface that
 * offers, resolves, or defaults a create destination shares this check.
 */
export function automationCreateHostEligible(
  entry: AutomationHostCatalogEntry
): entry is AutomationHostCatalogEntry & { owner: AutomationOwnerRef } {
  return entry.kind !== 'orphan' && entry.owner !== null && entry.querySupport === 'scoped'
}

/**
 * What the picker lists: a superset of eligibility on purpose. An ineligible
 * host renders disabled with its status stated, because a host the rest of the
 * app still shows must not silently vanish here — omission reads as the host
 * being gone. Only rows that can never become destinations stay hidden: the
 * orphan bucket and removed targets.
 */
export function automationCreateHostOffered(entry: AutomationHostCatalogEntry): boolean {
  return entry.kind !== 'orphan' && entry.catalogState !== 'removed'
}

/**
 * The authorities whose ineligibility a server update would repair, named so
 * the field can say which machines need updating. A disabled row cannot explain
 * itself — its tooltip sits behind pointer-events: none — and not every
 * disabled host is repaired this way (an unverified target needs a reconnect),
 * so the hint names exactly the update-repairable ones.
 */
export function automationCreateUpdateRequiredAuthorityLabels(
  entries: readonly AutomationHostCatalogEntry[]
): string[] {
  const labels = entries
    .filter(automationCreateHostOffered)
    .filter((entry) => !automationCreateHostEligible(entry))
    .filter((entry) => automationHostRecoveryActions(entry).authority === 'update-server')
    .map((entry) => entry.authorityLabel)
  return [...new Set(labels)]
}

export function resolveAutomationCreateDestination(
  entry: AutomationHostCatalogEntry | null | undefined
): AutomationCreateDestinationResolution {
  if (!entry) {
    return { status: 'choice-required', reason: 'unselected' }
  }
  if (entry.kind === 'orphan') {
    return { status: 'choice-required', reason: 'orphan' }
  }
  if (!automationCreateHostEligible(entry)) {
    return { status: 'choice-required', reason: 'unavailable' }
  }
  return {
    status: 'ready',
    authority: entry.owner.authority,
    destination: { selector: entry.owner.selector },
    entry
  }
}

/**
 * Under All hosts, a pre-fill is a convenience, never a fallback: an
 * unresolvable active workspace leaves the choice to the user.
 */
export function preselectAutomationCreateHost(
  entries: readonly AutomationHostCatalogEntry[],
  selectedStableKey: string | null,
  activeWorkspaceStableKey: string | null
): AutomationHostCatalogEntry | null {
  const key = selectedStableKey ?? activeWorkspaceStableKey
  if (!key) {
    return null
  }
  return entries.find((entry) => entry.stableKey === key) ?? null
}

/**
 * Re-resolves the captured destination against the live catalog. A changed
 * incarnation is reported rather than followed, so the caller can keep the form
 * and say which host moved.
 */
export function revalidateAutomationCreateDestination(
  captured: AutomationCreateDestination,
  entries: readonly AutomationHostCatalogEntry[]
): AutomationCreateDestinationResolution | { status: 'stale'; entry: AutomationHostCatalogEntry } {
  const current = entries.find((entry) => entry.stableKey === captured.entry.stableKey)
  const resolved = resolveAutomationCreateDestination(current)
  if (resolved.status !== 'ready') {
    return resolved
  }
  return isSameAutomationOwner(destinationOwner(resolved), destinationOwner(captured))
    ? resolved
    : { status: 'stale', entry: resolved.entry }
}

/**
 * One eligible host is not a guess: with nothing else the user could choose, the
 * destination is still stated. Gated on positive hydration evidence, because a
 * catalog that has not settled can look single-host while a second one loads.
 */
export function soleAutomationCreateHost(
  entries: readonly AutomationHostCatalogEntry[],
  hydration: AutomationCatalogHydrationEvidence
): AutomationHostCatalogEntry | null {
  if (!hydration.runtimeCatalogSettled || !hydration.desktopSshHydrated) {
    return null
  }
  const eligible = entries.filter(automationCreateHostEligible)
  return eligible.length === 1 ? (eligible[0] ?? null) : null
}

/** The catalog host a workspace's execution host names, for the All-hosts pre-fill. */
export function automationCreateHostStableKey(hostId: string | null | undefined): string | null {
  const host = parseExecutionHostId(hostId)
  if (!host) {
    return null
  }
  if (host.kind === 'runtime') {
    return hostStableKey({
      authority: { kind: 'runtime', environmentId: host.environmentId },
      selector: { kind: 'self' }
    })
  }
  // A desktop SSH workspace is still desktop-stored; only the selector differs.
  return hostStableKey({
    authority: { kind: 'desktop' },
    selector: host.kind === 'ssh' ? { kind: 'ssh', targetId: host.targetId } : { kind: 'self' }
  })
}

/**
 * Whether the project can live on the destination at all, answered by the
 * destination authority's own repo table.
 *
 * Fail closed on a miss: repo ids are host-local, and every candidate this
 * dialog offers is a live row of this client's catalog, so a row the
 * destination's table does not hold is provably another authority's — sending
 * its id would only defer the refusal to the destination (`repo_not_found`).
 * Contrast `automationAuthorityPartitionContext`, which stays fail-open for
 * *stored* automation rows whose project may simply not be mirrored yet.
 */
export function automationCreateProjectMismatch(
  tables: AutomationAuthorityRepoTables,
  destination: AutomationCreateDestination,
  projectId: string
): boolean {
  const table = tables.get(automationAuthorityCatalogKey(destination.authority))
  const connectionId = table ? repoConnectionIdIn(table)(projectId) : undefined
  if (connectionId === undefined) {
    return true
  }
  const selector = destination.destination.selector
  return selector.kind === 'ssh' ? connectionId !== selector.targetId : connectionId !== null
}

/**
 * The projects a destination can hold, filtered by the rule submit already
 * enforces, so the form cannot offer a pairing its own check will refuse.
 */
export function automationCreateEligibleProjects<TProject extends { id: string }>(
  tables: AutomationAuthorityRepoTables,
  destination: AutomationCreateDestination,
  projects: readonly TProject[]
): TProject[] {
  return projects.filter(
    (project) => !automationCreateProjectMismatch(tables, destination, project.id)
  )
}

function destinationOwner(value: AutomationCreateDestination): AutomationOwnerRef {
  return { authority: value.authority, selector: value.destination.selector }
}
