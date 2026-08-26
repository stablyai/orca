/**
 * Turns a recovery verb into the one action that can actually fix it.
 *
 * The verbs come from `automation-host-status-descriptors.ts` and are never
 * invented here; this module only decides *what* Retry, Reconnect, and Update
 * server mean for a given host. Reconnect dials the thing that is down — the
 * runtime transport or the SSH target — and Update server can only take the user
 * to where the version is managed, because nothing in the app updates a host.
 */

import type { SettingsNavigationTarget } from '@/lib/settings-navigation-types'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import type { AutomationHostRecoveryAction } from './automation-host-status-descriptors'

export type AutomationHostRecoveryDeps = {
  /** Forces one fresh query for this host, bypassing TTL and retry cooldown. */
  retry: (entry: AutomationHostCatalogEntry) => void
  connectSshTarget: (targetId: string) => void
  connectRuntimeEnvironment: (environmentId: string) => void
  openSettings: (target: SettingsNavigationTarget) => void
}

/** Where a host's version is managed; the app cannot update a host on its own. */
function versionSettingsTarget(entry: AutomationHostCatalogEntry): SettingsNavigationTarget {
  if (entry.stableRef.authority.kind === 'runtime') {
    return { pane: 'servers', repoId: null }
  }
  // A desktop SSH host with no registration generation is a stale registration,
  // repaired by re-adding the target rather than by updating anything.
  return { pane: entry.stableRef.selector.kind === 'ssh' ? 'ssh' : 'automations', repoId: null }
}

function reconnect(entry: AutomationHostCatalogEntry, deps: AutomationHostRecoveryDeps): void {
  const authority = entry.stableRef.authority
  // Authority first: an unreachable server cannot be asked to dial its own targets.
  if (authority.kind === 'runtime' && entry.authorityHealth === 'unavailable') {
    deps.connectRuntimeEnvironment(authority.environmentId)
    return
  }
  if (entry.stableRef.selector.kind === 'ssh') {
    deps.connectSshTarget(entry.stableRef.selector.targetId)
    return
  }
  if (authority.kind === 'runtime') {
    deps.connectRuntimeEnvironment(authority.environmentId)
    return
  }
  // Desktop Self has no transport to dial, so the only honest fallback is to re-ask.
  deps.retry(entry)
}

export function runAutomationHostRecovery(
  action: AutomationHostRecoveryAction,
  entry: AutomationHostCatalogEntry | null,
  deps: AutomationHostRecoveryDeps
): void {
  if (!entry) {
    return
  }
  switch (action) {
    case 'retry':
      deps.retry(entry)
      return
    case 'reconnect':
      reconnect(entry, deps)
      return
    case 'update-server':
      deps.openSettings(versionSettingsTarget(entry))
  }
}
