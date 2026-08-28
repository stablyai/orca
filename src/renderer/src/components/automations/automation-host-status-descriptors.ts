import { translate } from '@/i18n/i18n'
import type {
  AutomationAuthorityHealth,
  AutomationExecutionHealth,
  AutomationHostCatalogEntry,
  AutomationHostScopeGap
} from './automation-host-catalog-types'

/**
 * Copy and tone for the two independent health axes. They stay separate all the
 * way to the badge: an authority that cannot be queried is a different failure
 * from a target that is not connected, and collapsing them hides one of the two.
 */

export type AutomationHostStatusTone = 'neutral' | 'quiet' | 'attention' | 'error'

export type AutomationHostStatusDescriptor = {
  /** Locale-independent id — the stable hook for tests and CSS, never displayed. */
  id: string
  label: string
  description: string
  tone: AutomationHostStatusTone
  /** The healthy resting value; callers hide these unless asked to show everything. */
  isDefault: boolean
}

/** What a persistent failure offers the user; never a toast (design doc, UX section). */
export type AutomationHostRecoveryAction = 'retry' | 'reconnect' | 'update-server'

export type AutomationHostRecoveryActions = {
  authority: AutomationHostRecoveryAction | null
  execution: AutomationHostRecoveryAction | null
}

export function authorityHealthDescriptor(
  health: AutomationAuthorityHealth
): AutomationHostStatusDescriptor {
  switch (health) {
    case 'loading':
      return {
        id: 'authority-loading',
        label: translate('auto.components.automations.hostStatus.authority.loading', 'Loading'),
        description: translate(
          'auto.components.automations.hostStatus.authority.loadingDescription',
          'Loading automations from this host.'
        ),
        tone: 'quiet',
        isDefault: false
      }
    case 'fresh':
      return {
        id: 'authority-fresh',
        label: translate('auto.components.automations.hostStatus.authority.fresh', 'Up to date'),
        description: translate(
          'auto.components.automations.hostStatus.authority.freshDescription',
          'Automations loaded from this host.'
        ),
        tone: 'neutral',
        isDefault: true
      }
    case 'refreshing':
      return {
        id: 'authority-refreshing',
        label: translate(
          'auto.components.automations.hostStatus.authority.refreshing',
          'Refreshing'
        ),
        description: translate(
          'auto.components.automations.hostStatus.authority.refreshingDescription',
          'Checking this host for changes.'
        ),
        tone: 'quiet',
        isDefault: false
      }
    case 'stale-error':
      // Why: the rows on screen are real, just not re-verified — say that, don't call them stale data.
      return {
        id: 'authority-stale-error',
        label: translate(
          'auto.components.automations.hostStatus.authority.staleError',
          'Not refreshed'
        ),
        description: translate(
          'auto.components.automations.hostStatus.authority.staleErrorDescription',
          'Showing the automations last loaded from this host. The most recent refresh did not complete.'
        ),
        tone: 'attention',
        isDefault: false
      }
    case 'unavailable':
      return {
        id: 'authority-unavailable',
        label: translate(
          'auto.components.automations.hostStatus.authority.unavailable',
          'Unreachable'
        ),
        description: translate(
          'auto.components.automations.hostStatus.authority.unavailableDescription',
          'This host could not be reached, so its automations could not be loaded.'
        ),
        tone: 'error',
        isDefault: false
      }
    case 'incompatible':
      return {
        id: 'authority-incompatible',
        label: translate(
          'auto.components.automations.hostStatus.authority.incompatible',
          'Update server'
        ),
        description: translate(
          'auto.components.automations.hostStatus.authority.incompatibleDescription',
          'This server does not support host-scoped automation queries. Update it to load automations for this host.'
        ),
        tone: 'attention',
        isDefault: false
      }
  }
}

export function executionHealthDescriptor(
  health: AutomationExecutionHealth
): AutomationHostStatusDescriptor {
  switch (health) {
    case 'connected':
      return {
        id: 'execution-connected',
        label: translate('auto.components.automations.hostStatus.execution.connected', 'Connected'),
        description: translate(
          'auto.components.automations.hostStatus.execution.connectedDescription',
          'This host is connected and can run automations.'
        ),
        tone: 'neutral',
        isDefault: true
      }
    case 'connecting':
      return {
        id: 'execution-connecting',
        label: translate(
          'auto.components.automations.hostStatus.execution.connecting',
          'Connecting'
        ),
        description: translate(
          'auto.components.automations.hostStatus.execution.connectingDescription',
          'Connecting to this host.'
        ),
        tone: 'quiet',
        isDefault: false
      }
    case 'disconnected':
      return {
        id: 'execution-disconnected',
        label: translate(
          'auto.components.automations.hostStatus.execution.disconnected',
          'Not connected'
        ),
        description: translate(
          'auto.components.automations.hostStatus.execution.disconnectedDescription',
          'Automations on this host cannot run until the connection is restored.'
        ),
        tone: 'attention',
        isDefault: false
      }
    case 'unavailable':
      return {
        id: 'execution-unavailable',
        label: translate(
          'auto.components.automations.hostStatus.execution.unavailable',
          'Unavailable'
        ),
        description: translate(
          'auto.components.automations.hostStatus.execution.unavailableDescription',
          'This execution target is no longer available.'
        ),
        tone: 'error',
        isDefault: false
      }
    case 'unknown':
      // Why: not knowing is not the same as being down; never render this as a failure.
      return {
        id: 'execution-unknown',
        label: translate(
          'auto.components.automations.hostStatus.execution.unknown',
          'Connection unknown'
        ),
        description: translate(
          'auto.components.automations.hostStatus.execution.unknownDescription',
          'The connection state for this host has not loaded yet.'
        ),
        tone: 'quiet',
        isDefault: false
      }
  }
}

export function automationHostRecoveryActions(
  entry: AutomationHostCatalogEntry
): AutomationHostRecoveryActions {
  return {
    authority: authorityRecoveryAction(entry),
    execution: executionRecoveryAction(entry.executionHealth)
  }
}

function authorityRecoveryAction(
  entry: AutomationHostCatalogEntry
): AutomationHostRecoveryAction | null {
  if (entry.authorityHealth === 'incompatible' || entry.querySupport === 'incompatible') {
    return 'update-server'
  }
  if (entry.authorityHealth === 'unavailable') {
    // The transport to the authority is down, so retrying the query alone cannot help.
    return 'reconnect'
  }
  if (entry.querySupport !== 'scoped') {
    return scopeGapRecoveryAction(entry.scopeGap)
  }
  return entry.authorityHealth === 'stale-error' ? 'retry' : null
}

/** Updating a server only repairs a server that actually answered without host scoping. */
function scopeGapRecoveryAction(
  gap: AutomationHostScopeGap | undefined
): AutomationHostRecoveryAction | null {
  switch (gap) {
    case 'target-unverified':
      return 'reconnect'
    case 'target-removed':
    case 'target-unregistered':
      return null
    // An unscoped contract with no recorded cause can only be the authority's own.
    case 'authority-unscoped':
    case undefined:
      return 'update-server'
  }
}

function executionRecoveryAction(
  health: AutomationExecutionHealth
): AutomationHostRecoveryAction | null {
  // `unavailable` is only reached for a removed target, which reconnecting cannot revive.
  return health === 'disconnected' ? 'reconnect' : null
}

export function recoveryActionLabel(action: AutomationHostRecoveryAction): string {
  switch (action) {
    case 'retry':
      return translate('auto.components.automations.hostStatus.action.retry', 'Retry')
    case 'reconnect':
      return translate('auto.components.automations.hostStatus.action.reconnect', 'Reconnect')
    case 'update-server':
      return translate(
        'auto.components.automations.hostStatus.action.updateServer',
        'Update server'
      )
  }
}
