/** State the storage destination explicitly. A concrete filter constrains it; All hosts may prefill only a catalog-backed executable owner, otherwise ask. Revalidate before submit so changed incarnations refuse without losing the form. */

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

/** Share create eligibility across surfaces: require an executable owner and scoped queries so a new record can be listed and edited afterward. */
export function automationCreateHostEligible(
  entry: AutomationHostCatalogEntry
): entry is AutomationHostCatalogEntry & { owner: AutomationOwnerRef } {
  return entry.kind !== 'orphan' && entry.owner !== null && entry.querySupport === 'scoped'
}

/** Offer ineligible hosts disabled with reasons so they do not appear gone; hide only removed targets and the orphan bucket. */
export function automationCreateHostOffered(entry: AutomationHostCatalogEntry): boolean {
  return entry.kind !== 'orphan' && entry.catalogState !== 'removed'
}

/** Name only authorities repaired by a server update; disabled tooltips are unreachable, and unverified targets need reconnect instead. */
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

/** Under All hosts, prefill only a resolvable workspace host; otherwise leave the choice to the user. */
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

/** Revalidate against the live catalog; report a changed incarnation without silently following it or discarding the form. */
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

/** Default a sole eligible host only after positive hydration evidence; another host may still be loading. */
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

/** Validate new projects against the destination authority’s repo table and fail closed on misses (repo_not_found). Stored rows use the more permissive automationAuthorityPartitionContext because their mirrors may lag. */
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

/** Offer only project/destination pairs the submit check accepts. */
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
