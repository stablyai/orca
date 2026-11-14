import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { AutomationHostCatalogEntry } from '../hosts/automation-host-catalog-types'
import type {
  AutomationHostFilterResolution,
  AutomationHostFilterStatus
} from '../hosts/automation-host-filter-resolution'
import {
  automationHostRecoveryActions,
  type AutomationHostRecoveryAction
} from '../hosts/automation-host-status-descriptors'

/** Describe disconnected, unreachable or unhydrated hosts as unknown, never empty; no storage read established that claim. */

export type AutomationListEmptyStateKind =
  /** Rows exist; render the list, not a state. */
  | 'rows'
  | 'search-no-match'
  | 'host-empty'
  | 'all-hosts-empty'
  | 'host-error'
  | 'host-loading'
  | 'host-not-connected'
  | 'host-unavailable'

export type AutomationListEmptyState = {
  kind: AutomationListEmptyStateKind
  title: string
  detail: string | null
  recovery: AutomationHostRecoveryAction | null
}

export type AutomationListEmptyStateInput = {
  resolution: AutomationHostFilterResolution
  /** Rows for the selected host before the search query or attribute filter is applied. */
  hostRowCount: number
  /** Rows still visible after the search query and attribute filter. */
  visibleRowCount: number
  searchActive: boolean
  /** True while the status/last-run/agent/host filter menu narrows the list. */
  filterActive?: boolean
}

function hostLabel(input: AutomationListEmptyStateInput, t: Translate = translate): string {
  return (
    input.resolution.entry?.label ??
    t('auto.components.automations.emptyState.unknownHost', 'this host')
  )
}

function state(
  kind: AutomationListEmptyStateKind,
  title: string,
  detail: string | null,
  _input: AutomationListEmptyStateInput,
  recovery: AutomationHostRecoveryAction | null = null
): AutomationListEmptyState {
  return { kind, title, detail, recovery }
}

function resolveSelectedHostState(
  input: AutomationListEmptyStateInput,
  t: Translate = translate
): AutomationListEmptyState {
  const label = hostLabel(input, t)
  const entry = input.resolution.entry
  const recovery = entry ? automationHostRecoveryActions(entry) : null

  if (input.resolution.status === 'loading' || entry?.catalogState === 'unhydrated') {
    return state(
      'host-loading',
      t('auto.components.automations.emptyState.hostLoading', 'Loading host…'),
      t(
        'auto.components.automations.emptyState.hostLoadingDetail',
        'Waiting for {{hostLabel}} to report its automations.',
        { hostLabel: label }
      ),
      input
    )
  }
  if (input.resolution.status === 'unavailable' || entry?.authorityHealth === 'unavailable') {
    return state(
      'host-unavailable',
      t(
        'auto.components.automations.emptyState.hostError',
        'Automations could not be loaded from {{hostLabel}}',
        { hostLabel: label }
      ),
      t(
        'auto.components.automations.emptyState.hostUnavailableDetail',
        'The host could not be reached, so its automations are unknown.'
      ),
      input,
      recovery?.authority ?? 'reconnect'
    )
  }
  if (entry?.authorityHealth === 'stale-error' || entry?.authorityHealth === 'incompatible') {
    return state(
      'host-error',
      t(
        'auto.components.automations.emptyState.hostError',
        'Automations could not be loaded from {{hostLabel}}',
        { hostLabel: label }
      ),
      entry.authorityHealth === 'incompatible'
        ? t(
            'auto.components.automations.emptyState.hostIncompatibleDetail',
            'This server is too old to scope automations by host.'
          )
        : t(
            'auto.components.automations.emptyState.hostStaleDetail',
            'The most recent refresh did not complete.'
          ),
      input,
      recovery?.authority ?? 'retry'
    )
  }
  if (entry && entry.executionHealth !== 'connected') {
    // Why: an unconnected target has told us nothing about storage, so "no automations" would overclaim.
    return state(
      'host-not-connected',
      t(
        'auto.components.automations.emptyState.hostNotConnected',
        '{{hostLabel}} is not connected',
        { hostLabel: label }
      ),
      t(
        'auto.components.automations.emptyState.hostNotConnectedDetail',
        'Connect to this host to see the automations stored for it.'
      ),
      input,
      recovery?.execution ?? 'reconnect'
    )
  }
  return state(
    'host-empty',
    t('auto.components.automations.emptyState.hostEmpty', 'No automations on {{hostLabel}}', {
      hostLabel: label
    }),
    null,
    input
  )
}

export type AutomationListHostGroupEmptyStateInput = Omit<
  AutomationListEmptyStateInput,
  'resolution'
> & { entry: AutomationHostCatalogEntry }

function groupHostStatus(entry: AutomationHostCatalogEntry): AutomationHostFilterStatus {
  if (entry.catalogState === 'unhydrated') {
    return 'loading'
  }
  return entry.authorityHealth === 'unavailable' ? 'unavailable' : 'ready'
}

/** Reuse the single-host resolver for All-hosts groups so unreachable cannot drift into empty. */
export function resolveAutomationHostGroupEmptyState(
  input: AutomationListHostGroupEmptyStateInput,
  t?: Translate
): AutomationListEmptyState {
  const { entry, ...counts } = input
  return resolveAutomationListEmptyState(
    {
      ...counts,
      resolution: {
        effective: { kind: 'host', host: entry.stableRef },
        entry,
        status: groupHostStatus(entry),
        announceFallback: false
      }
    },
    t
  )
}

export function resolveAutomationListEmptyState(
  input: AutomationListEmptyStateInput,
  t: Translate = translate
): AutomationListEmptyState {
  if (input.visibleRowCount > 0) {
    return { kind: 'rows', title: '', detail: null, recovery: null }
  }
  if ((input.searchActive || input.filterActive) && input.hostRowCount > 0) {
    // The host has rows; only the query or the attribute filter emptied the view.
    return state(
      'search-no-match',
      input.searchActive
        ? t(
            'auto.components.automations.emptyState.searchNoMatch',
            'No automations match your search'
          )
        : t(
            'auto.components.automations.emptyState.filtersNoMatch',
            'No automations match your filters'
          ),
      null,
      input
    )
  }
  if (input.resolution.effective.kind === 'all') {
    return state(
      'all-hosts-empty',
      t(
        'auto.components.automations.emptyState.allHostsEmpty',
        'No automations across loaded hosts'
      ),
      null,
      input
    )
  }
  return resolveSelectedHostState(input, t)
}
