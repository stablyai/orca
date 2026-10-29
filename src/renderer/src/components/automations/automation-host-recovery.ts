/** Use descriptor recovery verbs; reconnect the failed runtime or SSH target, and route Update server to version management. */

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

/** The Remote Orca Servers pane owns each runtime's version status and update action. */
function versionSettingsTarget(entry: AutomationHostCatalogEntry): SettingsNavigationTarget {
  if (entry.stableRef.authority.kind === 'runtime') {
    return {
      pane: 'servers',
      repoId: null,
      sectionId: entry.stableRef.authority.environmentId
    }
  }
  // Repair unregistered desktop SSH targets by re-adding them rather than updating the server.
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
