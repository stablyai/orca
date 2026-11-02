import { hostStableKey, parseHostStableKey } from '../../../../shared/automation-owner-key'
import { translate } from '@/i18n/i18n'
import type {
  AutomationOwnerRef,
  StableAutomationAuthorityRef,
  StableAutomationCatalogRef
} from '../../../../shared/automation-owner-ref'
import { isOwnedSshTargetId } from '../../../../shared/execution-host'
import {
  automationAuthorityCatalogKey,
  type AutomationCatalogSshMirrorInput,
  type AutomationHostCatalog,
  type AutomationHostCatalogEntry,
  type AutomationHostCatalogInput,
  type AutomationHostCatalogState,
  type AutomationHostQuerySupport,
  type AutomationHostScopeGap,
  type AutomationAuthorityHealth
} from './automation-host-catalog-types'
import { resolveSelfExecutionHealth, resolveSshExecutionHealth } from './automation-host-health'
import { orderAutomationHostCatalogEntries } from './automation-host-catalog-order'

/** Project mirrored state without connecting or probing; authority health/capabilities are inputs, so rendering the picker adds no network traffic. */

export function automationOrphanEntryLabel(): string {
  return translate(
    'auto.components.automations.hostCatalog.orphanEntryLabel',
    'Unassigned legacy automations'
  )
}

type ReferencedAuthorityScope = { targetIds: Set<string>; orphan: boolean }

type AuthorityProjectionContext = {
  authority: StableAutomationAuthorityRef
  authorityLabel: string
  authorityHealth: AutomationAuthorityHealth
  querySupport: AutomationHostQuerySupport
  /** Null for the desktop authority, which has no pairing incarnation. */
  pairingRevision: number | null
  ssh: AutomationCatalogSshMirrorInput
  referenced: ReferencedAuthorityScope
  orphanCount: number | undefined
}

const EMPTY_SCOPE: ReferencedAuthorityScope = { targetIds: new Set(), orphan: false }

function groupReferencedKeys(
  keys: Iterable<string> | undefined
): ReadonlyMap<string, ReferencedAuthorityScope> {
  const grouped = new Map<string, ReferencedAuthorityScope>()
  for (const key of keys ?? []) {
    const ref = parseHostStableKey(key)
    if (!ref) {
      continue
    }
    const authorityKey = automationAuthorityCatalogKey(ref.authority)
    let scope = grouped.get(authorityKey)
    if (!scope) {
      scope = { targetIds: new Set(), orphan: false }
      grouped.set(authorityKey, scope)
    }
    if (ref.selector.kind === 'ssh') {
      scope.targetIds.add(ref.selector.targetId)
    } else if (ref.selector.kind === 'orphan') {
      scope.orphan = true
    }
  }
  return grouped
}

function toOwner(
  ctx: AuthorityProjectionContext,
  selector: AutomationOwnerRef['selector']
): AutomationOwnerRef {
  return {
    authority:
      ctx.pairingRevision === null || ctx.authority.kind === 'desktop'
        ? { kind: 'desktop' }
        : {
            kind: 'runtime',
            environmentId: ctx.authority.environmentId,
            pairingRevision: ctx.pairingRevision
          },
    selector
  }
}

function makeEntry(
  stableRef: StableAutomationCatalogRef,
  entry: Omit<AutomationHostCatalogEntry, 'stableRef' | 'stableKey'>
): AutomationHostCatalogEntry {
  return { ...entry, stableRef, stableKey: hostStableKey(stableRef) }
}

/** Omitted rather than passed as undefined: absence is what marks the entry fully scoped. */
function withScopeGap(scopeGap: AutomationHostScopeGap | undefined): {
  scopeGap?: AutomationHostScopeGap
} {
  return scopeGap === undefined ? {} : { scopeGap }
}

/** The authority's own contract; the only gap an entry with no target can have. */
function authorityScopeGap(
  querySupport: AutomationHostQuerySupport
): AutomationHostScopeGap | undefined {
  return querySupport === 'legacy-unscoped' ? 'authority-unscoped' : undefined
}

function projectSelfEntry(ctx: AuthorityProjectionContext): AutomationHostCatalogEntry {
  return makeEntry(
    { authority: ctx.authority, selector: { kind: 'self' } },
    {
      owner: toOwner(ctx, { kind: 'self' }),
      label: ctx.authorityLabel,
      authorityLabel: ctx.authorityLabel,
      kind: 'self',
      catalogState: 'authoritative',
      authorityHealth: ctx.authorityHealth,
      executionHealth: resolveSelfExecutionHealth(ctx.authorityHealth),
      querySupport: ctx.querySupport,
      ...withScopeGap(authorityScopeGap(ctx.querySupport))
    }
  )
}

function resolveSshCatalogState(
  isLive: boolean,
  isTombstoned: boolean,
  targetsHydrated: boolean
): AutomationHostCatalogState {
  if (isLive) {
    return targetsHydrated ? 'authoritative' : 'unhydrated'
  }
  // Authority tombstones prove removal; bare absence needs a hydrated target list.
  return isTombstoned || targetsHydrated ? 'removed' : 'unhydrated'
}

/** Separate all four causes of missing generation; a target disconnect must not masquerade as old-server support. */
function resolveSshScopeGap(
  querySupport: AutomationHostQuerySupport,
  catalogState: AutomationHostCatalogState,
  generation: number | undefined
): AutomationHostScopeGap | undefined {
  if (querySupport !== 'scoped') {
    return authorityScopeGap(querySupport)
  }
  if (catalogState === 'removed') {
    return 'target-removed'
  }
  // Checked before the generation: a stale bucket drops generations on a mere disconnect.
  if (catalogState === 'unhydrated') {
    return 'target-unverified'
  }
  return generation === undefined ? 'target-unregistered' : undefined
}

function projectSshEntries(ctx: AuthorityProjectionContext): AutomationHostCatalogEntry[] {
  const liveTargets = new Map(
    ctx.ssh.targets
      .filter((target) => !isOwnedSshTargetId(target.targetId))
      .map((target) => [target.targetId, target])
  )
  const candidateIds = new Set<string>(liveTargets.keys())
  for (const targetId of ctx.ssh.removedTargetLabels.keys()) {
    candidateIds.add(targetId)
  }
  for (const targetId of ctx.referenced.targetIds) {
    candidateIds.add(targetId)
  }
  const entries: AutomationHostCatalogEntry[] = []
  for (const targetId of candidateIds) {
    if (isOwnedSshTargetId(targetId)) {
      continue
    }
    const live = liveTargets.get(targetId)
    const catalogState = resolveSshCatalogState(
      live !== undefined,
      ctx.ssh.removedTargetLabels.has(targetId),
      ctx.ssh.targetsHydrated
    )
    const generation = live?.generation
    const scoped = ctx.querySupport === 'scoped' && generation !== undefined
    entries.push(
      makeEntry(
        { authority: ctx.authority, selector: { kind: 'ssh', targetId } },
        {
          owner:
            scoped && catalogState === 'authoritative' && generation !== undefined
              ? toOwner(ctx, { kind: 'ssh', targetId, targetGeneration: generation })
              : null,
          label: live?.label ?? ctx.ssh.removedTargetLabels.get(targetId) ?? targetId,
          authorityLabel: ctx.authorityLabel,
          kind: 'ssh',
          catalogState,
          authorityHealth: ctx.authorityHealth,
          executionHealth: resolveSshExecutionHealth(
            catalogState,
            ctx.ssh.connectionStatusByTargetId.get(targetId),
            ctx.ssh.missingConnectionStatus
          ),
          // Why: without a registration generation the entry keys on target id alone, so it stays view-only.
          querySupport:
            ctx.querySupport === 'scoped' && !scoped ? 'legacy-unscoped' : ctx.querySupport,
          ...withScopeGap(resolveSshScopeGap(ctx.querySupport, catalogState, generation))
        }
      )
    )
  }
  return entries
}

function projectOrphanEntry(ctx: AuthorityProjectionContext): AutomationHostCatalogEntry | null {
  const orphanCount = ctx.orphanCount
  const settled = orphanCount !== undefined
  if (!ctx.referenced.orphan && !(orphanCount !== undefined && orphanCount > 0)) {
    return null
  }
  return makeEntry(
    { authority: ctx.authority, selector: { kind: 'orphan' } },
    {
      owner: null,
      label: automationOrphanEntryLabel(),
      authorityLabel: ctx.authorityLabel,
      kind: 'orphan',
      catalogState: settled ? 'authoritative' : 'unhydrated',
      authorityHealth: ctx.authorityHealth,
      executionHealth: 'unavailable',
      querySupport: ctx.querySupport,
      ...withScopeGap(authorityScopeGap(ctx.querySupport))
    }
  )
}

function projectAuthority(ctx: AuthorityProjectionContext): AutomationHostCatalogEntry[] {
  const orphan = projectOrphanEntry(ctx)
  return [projectSelfEntry(ctx), ...projectSshEntries(ctx), ...(orphan ? [orphan] : [])]
}

export function buildAutomationHostCatalog(
  input: AutomationHostCatalogInput
): AutomationHostCatalog {
  const referenced = groupReferencedKeys(input.referencedStableKeys)
  const desktopAuthority: StableAutomationAuthorityRef = { kind: 'desktop' }
  // Only a saved runtime can absorb the desktop authority; an unknown id leaves it projected.
  const desktopAlias = input.runtimes.find(
    (runtime) => runtime.environmentId === input.desktopAliasEnvironmentId
  )
  const desktopAliasEnvironmentId = desktopAlias?.environmentId
  const desktopContext: AuthorityProjectionContext = {
    authority: desktopAuthority,
    authorityLabel: input.desktop.label,
    authorityHealth: input.desktop.authorityHealth ?? 'fresh',
    querySupport: 'scoped',
    pairingRevision: null,
    ssh: input.desktop.ssh,
    referenced: referenced.get(automationAuthorityCatalogKey(desktopAuthority)) ?? EMPTY_SCOPE,
    orphanCount: input.desktop.orphanCount
  }
  const contexts: AuthorityProjectionContext[] = [
    ...(desktopAliasEnvironmentId === undefined ? [desktopContext] : []),
    ...input.runtimes.map((runtime): AuthorityProjectionContext => {
      const authority: StableAutomationAuthorityRef = {
        kind: 'runtime',
        environmentId: runtime.environmentId
      }
      return {
        authority,
        authorityLabel: runtime.label,
        authorityHealth: runtime.authorityHealth,
        querySupport: runtime.querySupport,
        pairingRevision: runtime.pairingRevision,
        ssh: runtime.ssh,
        referenced: referenced.get(automationAuthorityCatalogKey(authority)) ?? EMPTY_SCOPE,
        orphanCount: runtime.orphanCount
      }
    })
  ]
  const entries = orderAutomationHostCatalogEntries(contexts.flatMap(projectAuthority))
  const byStableKey = new Map(entries.map((entry) => [entry.stableKey, entry]))
  return {
    entries,
    byStableKey,
    hydration: {
      runtimeCatalogSettled: input.runtimeCatalogSettled,
      // A folded desktop's SSH targets are the runtime it folded into.
      desktopSshHydrated: (desktopAlias?.ssh ?? input.desktop.ssh).targetsHydrated,
      runtimeSshHydratedByEnvironmentId: new Map(
        input.runtimes.map((runtime) => [runtime.environmentId, runtime.ssh.targetsHydrated])
      ),
      savedRuntimeEnvironmentIds: new Set(input.runtimes.map((runtime) => runtime.environmentId)),
      orphanSettledAuthorityKeys: new Set(
        contexts
          .filter((ctx) => ctx.orphanCount !== undefined)
          .map((ctx) => automationAuthorityCatalogKey(ctx.authority))
      ),
      unavailableAuthorityKeys: new Set(
        contexts
          .filter((ctx) => ctx.authorityHealth === 'unavailable')
          .map((ctx) => automationAuthorityCatalogKey(ctx.authority))
      )
    }
  }
}
