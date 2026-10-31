import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
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
  foldDesktopHostFilter,
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

/** Keep query and display catalogs separate: apply mirrored membership to the controller, then fold query health into display without cancelling work on every cache commit. */

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
  /** Invalidate written hosts immediately so the list reflects save without waiting for the authority event; a later duplicate event is harmless. */
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
  // The controller outlives renders; its partition callback needs current authority repo tables.
  const repoTables = useMemo(() => groupReposByAutomationAuthority(repos), [repos])
  const repoTablesRef = useRef(repoTables)
  repoTablesRef.current = repoTables
  const makeController = useCallback(
    () =>
      createAutomationHostQueryController({
        // Use the answering authority’s repo evidence; colliding IDs or absences on another host prove nothing.
        legacyPartitionContext: (authority) =>
          automationAuthorityPartitionContext(repoTablesRef.current, authority),
        // Let the lifecycle effect subscribe; render-time controllers would leak listeners under StrictMode’s doubled initializer.
        eventTarget: null
      }),
    []
  )
  const [controller, setController] = useState<AutomationHostQueryController>(makeController)
  // StrictMode cleanup disposes the first controller; the effect replaces it and owns subscribe/unsubscribe/dispose so later writes still refresh.
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
  const hostFilter = useMemo(
    () => foldDesktopHostFilter(automationHostFilter, sourceState.desktopAliasEnvironmentId),
    [automationHostFilter, sourceState.desktopAliasEnvironmentId]
  )
  const selectedStableKey = automationHostFilterStableKey(hostFilter)
  // Include the persisted selection so a removed-but-selected host remains projected until resolution decides its fate.
  const referencedStableKeys = useMemo(
    () =>
      new Set([
        ...(options.referencedStableKeys ?? []),
        ...(selectedStableKey ? [selectedStableKey] : [])
      ]),
    [options.referencedStableKeys, selectedStableKey]
  )
  const languageRevision = useUiLanguageRevision()
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- cacheVersion is the cache's change signal: orphan counts only exist in committed answers, so the catalog re-reads them when the cache moves. Ordering collates in the UI language.
    [cacheVersion, desktopLabel, orphanCount, referencedStableKeys, sourceState, languageRevision]
  )

  // Apply by complete generation/scheduler signature, not catalog identity; label/health changes must not cancel work.
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
  const applyCatalog = useEffectEvent(
    () => void controller.applyCatalog(queryCatalog, { selectedStableKey })
  )
  useEffect(() => {
    applyCatalog()
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
        filter: hostFilter,
        catalog,
        // Exclude the selection’s self-reference here or it could prevent its positively removed host from ever being dropped.
        referencedStableKeys: new Set([
          ...(options.referencedStableKeys ?? []),
          ...catalog.entries
            .filter((entry) => (controller.cache.getByKey(entry.stableKey)?.data.length ?? 0) > 0)
            .map((entry) => entry.stableKey)
        ])
      }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- cacheVersion is the cache's change signal; the cache object itself never changes identity.
    [cacheVersion, catalog, controller, hostFilter, options.referencedStableKeys]
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
