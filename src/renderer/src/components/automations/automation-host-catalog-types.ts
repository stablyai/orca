import type {
  AutomationOwnerRef,
  StableAutomationAuthorityRef,
  StableAutomationCatalogRef
} from '../../../../shared/automation-owner-ref'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'

/**
 * Health of an authority's *stored-automation query path*. Never describes its
 * execution targets: a reachable authority keeps listing and editing records
 * whose SSH target is down (required invariant 6).
 */
export type AutomationAuthorityHealth =
  | 'loading'
  | 'fresh'
  | 'refreshing'
  | 'stale-error'
  | 'unavailable'
  | 'incompatible'

/** Health of the *execution target*, tracked independently of authority health. */
export type AutomationExecutionHealth =
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'unavailable'
  | 'unknown'

/** What list/fencing contract this entry can use. `legacy-unscoped` entries are view-only. */
export type AutomationHostQuerySupport = 'scoped' | 'legacy-unscoped' | 'incompatible'

/**
 * Why an entry cannot use host-scoped, fenced queries. Absent when it can.
 *
 * Only `authority-unscoped` is positive evidence about the authority's list
 * contract — a probe that actually came back without the capability. The target
 * reasons say nothing about the server's age and none of them are repaired by
 * updating it, so they must never share its badge copy or its recovery verb.
 */
export type AutomationHostScopeGap =
  /** The owning authority proved the target is gone (tombstone or hydrated absence). */
  | 'target-removed'
  /** No live registration has been seen yet; a disconnect clears generations too. */
  | 'target-unverified'
  /** The target is live and hydrated, but its authority issued it no registration generation. */
  | 'target-unregistered'
  /** The authority advertises no host-scoped list capability. */
  | 'authority-unscoped'

/** Whether the entry's membership is proven, merely remembered, or positively gone. */
export type AutomationHostCatalogState = 'authoritative' | 'unhydrated' | 'removed'

export type AutomationHostCatalogEntry = {
  stableRef: StableAutomationCatalogRef
  /** Null whenever no executable, fully fenced owner exists (ghost, unhydrated, orphan, legacy). */
  owner: AutomationOwnerRef | null
  stableKey: string
  label: string
  authorityLabel: string
  kind: 'self' | 'ssh' | 'orphan'
  catalogState: AutomationHostCatalogState
  authorityHealth: AutomationAuthorityHealth
  executionHealth: AutomationExecutionHealth
  querySupport: AutomationHostQuerySupport
  /** Present only while `querySupport` is degraded; explains which repair, if any, applies. */
  scopeGap?: AutomationHostScopeGap
}

export type AutomationCatalogSshTargetInput = {
  targetId: string
  label: string
  /** Durable registration generation; absent on legacy targets and old servers. */
  generation?: number
}

/** One authority's mirrored SSH state. Desktop and runtime supply the same shape. */
export type AutomationCatalogSshMirrorInput = {
  /** Absence only counts as removal once a target list actually loaded. */
  targetsHydrated: boolean
  targets: readonly AutomationCatalogSshTargetInput[]
  removedTargetLabels: ReadonlyMap<string, string>
  connectionStatusByTargetId: ReadonlyMap<string, SshConnectionStatus>
  /** Status assumed for a hydrated target with no recorded state; desktop passes `disconnected`. */
  missingConnectionStatus?: SshConnectionStatus
}

export type AutomationDesktopAuthorityInput = {
  label: string
  /** Desktop storage is local IPC, so this reflects query/cache state only. */
  authorityHealth?: AutomationAuthorityHealth
  ssh: AutomationCatalogSshMirrorInput
  /** Authoritative orphan count from the last list; absent means not yet known. */
  orphanCount?: number
}

export type AutomationRuntimeAuthorityInput = {
  environmentId: string
  label: string
  pairingRevision: number
  authorityHealth: AutomationAuthorityHealth
  /** Supplied by the caller from advertised capabilities; the projection never probes. */
  querySupport: AutomationHostQuerySupport
  ssh: AutomationCatalogSshMirrorInput
  orphanCount?: number
}

export type AutomationHostCatalogInput = {
  desktop: AutomationDesktopAuthorityInput
  /** Saved runtime environments — projected even while offline. */
  runtimes: readonly AutomationRuntimeAuthorityInput[]
  /** Gates Runtime+Self absence; a failed catalog read settles without hydrating. */
  runtimeCatalogSettled: boolean
  /** Stable keys still referenced by a stored automation, cached row, persisted filter, or tombstone. */
  referencedStableKeys?: Iterable<string>
}

/** Positive-evidence gates for absence. Missing data is never removal (invariant 4). */
export type AutomationCatalogHydrationEvidence = {
  runtimeCatalogSettled: boolean
  desktopSshHydrated: boolean
  runtimeSshHydratedByEnvironmentId: ReadonlyMap<string, boolean>
  savedRuntimeEnvironmentIds: ReadonlySet<string>
  /** Authority keys that returned an authoritative orphan count. */
  orphanSettledAuthorityKeys: ReadonlySet<string>
  /** Authority keys currently unreachable; their absences prove nothing. */
  unavailableAuthorityKeys: ReadonlySet<string>
}

export type AutomationHostCatalog = {
  /** Deterministically ordered; see `orderAutomationHostCatalogEntries`. */
  entries: readonly AutomationHostCatalogEntry[]
  byStableKey: ReadonlyMap<string, AutomationHostCatalogEntry>
  hydration: AutomationCatalogHydrationEvidence
}

/** Namespaced so an authority key can never be confused with one of its host keys. */
export function automationAuthorityCatalogKey(authority: StableAutomationAuthorityRef): string {
  return authority.kind === 'desktop'
    ? 'authority:desktop'
    : `authority:runtime:${encodeURIComponent(authority.environmentId)}`
}
