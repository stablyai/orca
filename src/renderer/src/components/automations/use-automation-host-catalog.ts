import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host'
import type { AutomationHostFilter } from '../../../../shared/automation-host-filter'
import type { StableAutomationAuthorityRef } from '../../../../shared/automation-owner-ref'
import { buildAutomationHostCatalog } from './automation-host-catalog'
import { subscribeAutomationHostInvalidation } from './automation-host-invalidation-window-events'
import { buildAutomationHostCatalogSource } from './automation-host-catalog-source'
import {
  automationHostLoadCounts,
  withAutomationHostCacheHealth,
  type AutomationHostLoadCounts
} from './automation-host-cache-health'
import {
  createAutomationHostQueryController,
  type AutomationHostQueryController
} from './automation-host-cache-controller'
import { automationHostCatalogEntryFingerprint } from './automation-host-catalog-generation'
import type { AutomationAuthorityChangeEvent } from './automation-host-invalidation'
import type {
  AutomationHostCatalog,
  AutomationHostCatalogEntry
} from './automation-host-catalog-types'
import { automationHostFilterStableKey } from '../../../../shared/automation-host-filter'
import {
  resolveAutomationHostFilter,
  type AutomationHostFilterResolution
} from './automation-host-filter-resolution'
import {
  resolveAutomationHostListRows,
  type AutomationHostListRows
} from './automation-host-list-rows'
import { automationHostFetchTarget } from './automation-host-fetch-target'
import {
  runAutomationHostRecovery,
  type AutomationHostRecoveryDeps
} from './automation-host-recovery'
import type { AutomationHostRecoveryAction } from './automation-host-status-descriptors'
import {
  automationAuthorityPartitionContext,
  automationRuntimePairingRevision,
  groupReposByAutomationAuthority
} from './automation-authority-identity'
import { useAutomationDesktopSshRegistrations } from './use-automation-desktop-ssh-registrations'
import { useAutomationHostCatalogSourceState } from './use-automation-host-catalog-source-state'

/**
 * Owns the per-host query controller and the two catalogs the page needs.
 *
 * There are deliberately two: the one applied to the controller is derived from
 * mirrored store state only, because applying a catalog advances generations and
 * cancels in-flight work, and a catalog derived from query results would do that
 * every time a query landed. The display catalog folds those results back in.
 */

export type AutomationHostCatalogView = {
  catalog: AutomationHostCatalog
  entries: readonly AutomationHostCatalogEntry[]
  resolution: AutomationHostFilterResolution
  rows: AutomationHostListRows
  loadCounts: AutomationHostLoadCounts
  selectHost: (filter: AutomationHostFilter) => void
  /** Runs the recovery verb the notice or empty state offered for a host. */
  recover: (action: AutomationHostRecoveryAction, entry?: AutomationHostCatalogEntry | null) => void
  /** Manual refresh of every host in view, bypassing TTL where reachable. */
  refreshHosts: () => void
  /**
   * Invalidates the host a local write just landed on, without waiting for the
   * authority's own event. The event still arrives and is harmless; what this
   * removes is the round trip between the save returning and the list agreeing.
   */
  notifyAuthorityChange: (event: AutomationAuthorityChangeEvent) => void
}

export type AutomationHostCatalogOptions = {
  /** Stable keys a stored automation or persisted filter still points at. */
  referencedStableKeys?: Iterable<string>
  /** Authorities whose most recent unscoped list attempt failed. */
  failedAuthorityKeys?: ReadonlySet<string>
}

export function useAutomationHostCatalog(
  options: AutomationHostCatalogOptions = {}
): AutomationHostCatalogView {
  const settings = useAppStore((s) => s.settings)
  const repos = useAppStore((s) => s.repos)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const automationHostFilter = useAppStore((s) => s.automationHostFilter)
  const setAutomationHostFilter = useAppStore((s) => s.setAutomationHostFilter)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const desktopSshGenerations = useAutomationDesktopSshRegistrations()

  const desktopLabel = useMemo(
    () => getHostDisplayLabelOverrides(settings).get('local') ?? getLocalExecutionHostLabel(),
    [settings]
  )
  // Why a ref: the controller outlives every render, so its legacy-partition
  // callback must read the latest repo tables, not the ones it was created with.
  const repoTables = useMemo(() => groupReposByAutomationAuthority(repos), [repos])
  const repoTablesRef = useRef(repoTables)
  repoTablesRef.current = repoTables
  const makeController = useCallback(
    () =>
      createAutomationHostQueryController({
        // Scoped to the answering authority: another host's identically named repo
        // is not evidence about this one, and its absence is not evidence either.
        legacyPartitionContext: (authority) =>
          automationAuthorityPartitionContext(repoTablesRef.current, authority),
        // Wired by the lifecycle effect below instead: a controller built during
        // render must hold no window subscription, or StrictMode's doubled
        // initializer leaks a live listener per mount.
        eventTarget: null
      }),
    []
  )
  const [controller, setController] = useState<AutomationHostQueryController>(makeController)
  // Create-in-render, dispose-in-cleanup is asymmetric under StrictMode's
  // simulated unmount: the cleanup disposes the only controller, and a disposed
  // controller silently drops every write invalidation — the list then never
  // shows a create until the app reloads. The effect owns the whole lifecycle:
  // it replaces a disposed controller and unsubscribes before disposing.
  useEffect(() => {
    if (controller.isDisposed()) {
      setController(makeController())
      return
    }
    const unsubscribe = subscribeAutomationHostInvalidation(controller.handleAuthorityEvent)
    return () => {
      unsubscribe()
      controller.dispose()
    }
  }, [controller, makeController])

  const [cacheVersion, setCacheVersion] = useState(0)
  useEffect(() => {
    return controller.cache.subscribe(() => setCacheVersion((version) => version + 1))
  }, [controller])

  const orphanCount = useCallback(
    (authority: StableAutomationAuthorityRef) => controller.authorityOrphanCount(authority),
    [controller]
  )
  const sourceState = useAutomationHostCatalogSourceState({
    desktopSshGenerations,
    runtimeEnvironments
  })
  const selectedStableKey = automationHostFilterStableKey(automationHostFilter)
  // The saved selection references itself: without this the catalog would omit a
  // removed host the user is still filtered to, and absence would read as removal.
  const referencedStableKeys = useMemo(
    () =>
      new Set([
        ...(options.referencedStableKeys ?? []),
        ...(selectedStableKey ? [selectedStableKey] : [])
      ]),
    [options.referencedStableKeys, selectedStableKey]
  )
  const queryCatalog = useMemo(
    () =>
      buildAutomationHostCatalog(
        buildAutomationHostCatalogSource({
          ...sourceState,
          desktopLabel,
          orphanCount,
          referencedStableKeys
        })
      ),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- cacheVersion is the cache's change signal: orphan counts only exist in committed answers, so the catalog re-reads them when the cache moves.
    [cacheVersion, desktopLabel, orphanCount, referencedStableKeys, sourceState]
  )

  // Why a signature rather than the catalog object: health and label changes
  // re-derive the catalog but must not re-apply it, since applying cancels work.
  // The generation fingerprint is embedded whole rather than summarised, so a
  // change the commit fence would reject can never fail to re-apply here.
  const applySignature = useMemo(
    () =>
      [
        selectedStableKey ?? '',
        ...queryCatalog.entries.map((entry) =>
          [
            automationHostCatalogEntryFingerprint(entry),
            entry.querySupport,
            entry.authorityHealth === 'unavailable' ? 'down' : 'up'
          ].join(':')
        )
      ].join('\n'),
    [queryCatalog, selectedStableKey]
  )
  useEffect(() => {
    void controller.applyCatalog(queryCatalog, { selectedStableKey })
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- applySignature is the apply policy: it covers the generation fingerprint plus every other field the scheduler reads, and keying off the catalog object would re-apply (and cancel in-flight work) on a label or health change.
  }, [applySignature, controller])

  const catalog = useMemo(
    () =>
      withAutomationHostCacheHealth(queryCatalog, {
        entry: (stableKey) => controller.cache.getByKey(stableKey),
        ...(options.failedAuthorityKeys ? { failedAuthorityKeys: options.failedAuthorityKeys } : {})
      }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- cacheVersion is the cache's change signal; the cache object itself never changes identity.
    [cacheVersion, controller, options.failedAuthorityKeys, queryCatalog]
  )
  const resolution = useMemo(
    () =>
      resolveAutomationHostFilter({
        filter: automationHostFilter,
        catalog,
        // Deliberately not `referencedStableKeys`: that set includes the saved
        // selection so the catalog still projects it, and a selection that
        // referenced itself could never be dropped when its host really goes.
        referencedStableKeys: new Set([
          ...(options.referencedStableKeys ?? []),
          ...catalog.entries
            .filter((entry) => (controller.cache.getByKey(entry.stableKey)?.data.length ?? 0) > 0)
            .map((entry) => entry.stableKey)
        ])
      }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- cacheVersion is the cache's change signal; the cache object itself never changes identity.
    [automationHostFilter, cacheVersion, catalog, controller, options.referencedStableKeys]
  )
  const rows = useMemo(
    () =>
      resolveAutomationHostListRows({
        catalog,
        resolution,
        entry: (stableKey) => controller.cache.getByKey(stableKey)
      }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- cacheVersion is the cache's change signal; the cache object itself never changes identity.
    [cacheVersion, catalog, controller, resolution]
  )

  const pairingRevision = useCallback(
    (environmentId: string) => automationRuntimePairingRevision(runtimeEnvironments, environmentId),
    [runtimeEnvironments]
  )
  const recoveryDeps = useMemo(
    (): AutomationHostRecoveryDeps => ({
      retry: (entry) => {
        void controller.scheduler.retry(automationHostFetchTarget(entry, pairingRevision))
      },
      connectSshTarget: (targetId) => {
        void window.api.ssh.connect({ targetId })
      },
      connectRuntimeEnvironment: (environmentId) => {
        void window.api.runtimeEnvironments.connect({ selector: environmentId })
      },
      openSettings: (target) => {
        openSettingsTarget(target)
        openSettingsPage()
      }
    }),
    [controller, openSettingsPage, openSettingsTarget, pairingRevision]
  )

  const recover = useCallback(
    (action: AutomationHostRecoveryAction, entry?: AutomationHostCatalogEntry | null) => {
      runAutomationHostRecovery(action, entry ?? resolution.entry, recoveryDeps)
    },
    [recoveryDeps, resolution.entry]
  )
  const refreshHosts = useCallback(() => {
    void controller.applyCatalog(queryCatalog, { selectedStableKey, force: true })
  }, [controller, queryCatalog, selectedStableKey])

  return {
    catalog,
    entries: catalog.entries,
    resolution,
    rows,
    loadCounts: useMemo(() => automationHostLoadCounts(catalog), [catalog]),
    selectHost: setAutomationHostFilter,
    recover,
    refreshHosts,
    notifyAuthorityChange: controller.handleAuthorityEvent
  }
}
