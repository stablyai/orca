/**
 * Projects mirrored renderer state into the catalog builder's input.
 *
 * Deliberately reads store state only. Query results are folded in later by
 * `automation-host-cache-health.ts`, because a catalog derived from the cache
 * would change every time the cache it drives commits, and re-applying a catalog
 * is what advances generations and cancels in-flight work.
 */

import { getLocalExecutionHostLabel } from '../../../../shared/execution-host'
import { AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import type { StableAutomationAuthorityRef } from '../../../../shared/automation-owner-ref'
import type {
  AutomationAuthorityHealth,
  AutomationCatalogSshMirrorInput,
  AutomationCatalogSshTargetInput,
  AutomationHostCatalogInput,
  AutomationHostQuerySupport
} from './automation-host-catalog-types'

/** The mirrored SSH state one authority exposes; desktop and runtime shapes converge here. */
export type AutomationCatalogSshSource = {
  targetsHydrated: boolean
  targetLabels: ReadonlyMap<string, string>
  /** Absent for a target whose authority never reported a registration generation. */
  targetGenerations?: ReadonlyMap<string, number>
  removedTargetLabels: ReadonlyMap<string, string>
  connectionStates: ReadonlyMap<string, { status: SshConnectionStatus }>
}

export type AutomationCatalogRuntimeSource = {
  environmentId: string
  label: string
  pairingRevision: number
  /** Undefined until this client has probed the environment at all. */
  status: { status: RuntimeStatus | null } | undefined
  ssh: AutomationCatalogSshSource | undefined
}

export type AutomationHostCatalogSource = {
  desktopLabel?: string
  desktopSsh: AutomationCatalogSshSource
  runtimes: readonly AutomationCatalogRuntimeSource[]
  runtimeCatalogSettled: boolean
  referencedStableKeys?: Iterable<string>
  /** Authoritative orphan counts the cache has seen, keyed by authority catalog key. */
  orphanCount?: (authority: StableAutomationAuthorityRef) => number | null
}

const EMPTY_SSH: AutomationCatalogSshSource = {
  targetsHydrated: false,
  targetLabels: new Map(),
  removedTargetLabels: new Map(),
  connectionStates: new Map()
}

function toSshTargets(source: AutomationCatalogSshSource): AutomationCatalogSshTargetInput[] {
  const targets: AutomationCatalogSshTargetInput[] = []
  for (const [targetId, label] of source.targetLabels) {
    const generation = source.targetGenerations?.get(targetId)
    targets.push({ targetId, label, ...(generation === undefined ? {} : { generation }) })
  }
  return targets
}

function toSshMirror(
  source: AutomationCatalogSshSource,
  missingConnectionStatus?: SshConnectionStatus
): AutomationCatalogSshMirrorInput {
  const connectionStatusByTargetId = new Map<string, SshConnectionStatus>()
  for (const [targetId, state] of source.connectionStates) {
    connectionStatusByTargetId.set(targetId, state.status)
  }
  return {
    targetsHydrated: source.targetsHydrated,
    targets: toSshTargets(source),
    removedTargetLabels: source.removedTargetLabels,
    connectionStatusByTargetId,
    ...(missingConnectionStatus ? { missingConnectionStatus } : {})
  }
}

/** A never-probed environment is loading, not down; only a failed probe proves unreachable. */
export function runtimeAuthorityHealth(
  runtime: AutomationCatalogRuntimeSource
): AutomationAuthorityHealth {
  if (!runtime.status) {
    return 'loading'
  }
  return runtime.status.status === null ? 'unavailable' : 'fresh'
}

/**
 * Optimistic on an unknown capability set, fail-closed on a known one: the
 * scoped client re-checks the capability before every list and raises the
 * update-required error itself, so guessing `legacy-unscoped` here would only
 * throw away owners on a modern host we have not probed yet.
 */
export function runtimeQuerySupport(
  runtime: AutomationCatalogRuntimeSource
): AutomationHostQuerySupport {
  const capabilities = runtime.status?.status?.capabilities
  if (!capabilities) {
    return 'scoped'
  }
  return capabilities.includes(AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY)
    ? 'scoped'
    : 'legacy-unscoped'
}

function orphanCountFor(
  source: AutomationHostCatalogSource,
  authority: StableAutomationAuthorityRef
): number | undefined {
  return source.orphanCount?.(authority) ?? undefined
}

export function buildAutomationHostCatalogSource(
  source: AutomationHostCatalogSource
): AutomationHostCatalogInput {
  return {
    desktop: {
      label: source.desktopLabel ?? getLocalExecutionHostLabel(),
      // Why 'disconnected' for a hydrated target with no state: the desktop
      // records a state the moment it dials, so silence means it never did.
      ssh: toSshMirror(source.desktopSsh, 'disconnected'),
      ...withOrphanCount(orphanCountFor(source, { kind: 'desktop' }))
    },
    runtimes: source.runtimes.map((runtime) => {
      const authority: StableAutomationAuthorityRef = {
        kind: 'runtime',
        environmentId: runtime.environmentId
      }
      return {
        environmentId: runtime.environmentId,
        label: runtime.label,
        pairingRevision: runtime.pairingRevision,
        authorityHealth: runtimeAuthorityHealth(runtime),
        querySupport: runtimeQuerySupport(runtime),
        ssh: toSshMirror(runtime.ssh ?? EMPTY_SSH),
        ...withOrphanCount(orphanCountFor(source, authority))
      }
    }),
    runtimeCatalogSettled: source.runtimeCatalogSettled,
    ...(source.referencedStableKeys ? { referencedStableKeys: source.referencedStableKeys } : {})
  }
}

/** Omitted rather than passed as undefined: absence is what marks the count unsettled. */
function withOrphanCount(orphanCount: number | undefined): { orphanCount?: number } {
  return orphanCount === undefined ? {} : { orphanCount }
}
