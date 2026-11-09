import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { resolveAiVaultSearchSettings } from '../../../../../../shared/ai-vault/search/ai-vault-search-settings'
import type { AiVaultSearchHostOutcome } from '../../../../../../shared/ai-vault/search/ai-vault-search-types'
import {
  getExecutionHostLabel,
  parseExecutionHostId
} from '../../../../../../shared/execution-host'
import type { useAiVaultPanelSearch } from './use-ai-vault-search'

// Keep reasons short to match adjacent host labels; null means the host answered.
function hostSkipReason(
  outcome: AiVaultSearchHostOutcome['outcome'],
  t: Translate = translate
): string | null {
  switch (outcome) {
    case 'searched':
      return null
    case 'stale':
      return t('sessionSearch.panel.hostSkipReason.indexChanged', 'index changed')
    case 'disabled':
      return t('sessionSearch.panel.hostSkipReason.searchOff', 'search off')
    case 'not-ready':
      return t('sessionSearch.panel.hostSkipReason.notReady', 'not ready')
    case 'no-service':
      return t('sessionSearch.panel.hostSkipReason.unavailable', 'unavailable')
    case 'unreachable':
      return t('sessionSearch.panel.hostSkipReason.unreachable', 'unreachable')
    case 'scope-unknown':
      return t('sessionSearch.panel.hostSkipReason.scopeNotFound', 'scope not found there')
    case 'unsupported-agent':
      return t('sessionSearch.panel.hostSkipReason.agentNotSupported', 'agent not supported')
  }
}

// Neither reached the scope, so neither is evidence that some computer did.
const UNSETTLED_SCOPE_OUTCOMES = new Set<AiVaultSearchHostOutcome['outcome']>([
  'scope-unknown',
  'unreachable'
])

// Name hosts lacking the project only when that explains otherwise empty results.
function describeSkippedHosts(
  hosts: readonly AiVaultSearchHostOutcome[],
  t: Translate = translate
): string | null {
  const anyResolved = hosts.some((entry) => !UNSETTLED_SCOPE_OUTCOMES.has(entry.outcome))
  const skipped = hosts.flatMap((entry) => {
    if (entry.outcome === 'scope-unknown' && anyResolved) {
      return []
    }
    const reason = hostSkipReason(entry.outcome, t)
    const label = getExecutionHostLabel(parseExecutionHostId(entry.executionHostId)?.id ?? null)
    return reason ? [`${label} (${reason})`] : []
  })
  return skipped.length > 0
    ? t('sessionSearch.panel.hostsSkipped', 'Not searched: {{value0}}', {
        value0: skipped.join(' · ')
      })
    : null
}

export function AiVaultPanelSearch({
  search,
  noAgents,
  children
}: {
  search: ReturnType<typeof useAiVaultPanelSearch>
  noAgents: boolean
  children: ReactNode
}) {
  const t = useTranslate()
  const { needsLocalConsent, response, error, loading, retry: onRetry } = search
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)
  async function enable() {
    setSaving(true)
    setSaveError(false)
    try {
      const store = useAppStore.getState()
      await store.updateSettingsOrThrow({
        aiVaultSearch: { ...resolveAiVaultSearchSettings(store.settings), enabled: true }
      })
      store.markFeatureTipsSeen(['agent-session-search'])
      onRetry()
    } catch {
      setSaveError(true)
    } finally {
      setSaving(false)
    }
  }
  // The consent card is an offer above the legacy title filter's own results, not a wall.
  if (!search.hasQuery) {
    return children
  }
  const unavailable = response?.kind === 'unavailable' ? response.reason : null
  let message: string | null = null
  if (needsLocalConsent) {
    message = t(
      'sessionSearch.panel.consent',
      'Enable full-text search? Orca builds an index on this computer from local agent transcripts, including full conversations. Content is not redacted. Authenticated paired clients can search it.'
    )
  } else if (noAgents) {
    message = t('auto.components.right.sidebar.AiVaultPanel.noAgentsSelected', 'No agents selected')
  } else if (search.titleOnly) {
    message = t(
      'sessionSearch.panel.titleOnly',
      'Full-text search is off on this computer, so only session titles are matched.'
    )
  } else if (unavailable === 'disabled') {
    message = t(
      'sessionSearch.panel.remoteDisabled',
      'Search is disabled on this computer. Enable transcript indexing on that computer to search its sessions.'
    )
  } else if (unavailable === 'not-ready') {
    message = t(
      'sessionSearch.panel.notReady',
      'The search index is not ready yet. Try again shortly.'
    )
  } else if (unavailable === 'no-service') {
    message = t(
      'sessionSearch.panel.noService',
      'Search is unavailable on this computer. It may need an Orca update or a runtime with search support.'
    )
  } else if (unavailable === 'unsupported-agent') {
    message = t(
      'sessionSearch.panel.unsupportedAgent',
      'This computer does not support history search for the selected agent. Update Orca on that computer or select another agent.'
    )
  } else if (unavailable === 'scope-unknown') {
    message = t(
      'sessionSearch.panel.scopeUnknown',
      'This computer does not have this workspace or project. Switch the scope to All to search everything on it.'
    )
  } else if (error) {
    message = t(
      'sessionSearch.panel.failed',
      'Could not search this computer. Check its connection and try again.'
    )
  } else if (response?.kind === 'stale-cursor' || response?.kind === 'malformed-cursor') {
    message = t(
      'sessionSearch.panel.changed',
      'The index changed while searching. Search again for current results.'
    )
  } else if (response?.kind === 'results') {
    if (
      response.truncated.candidates ||
      response.truncated.query ||
      response.truncated.snippets > 0
    ) {
      message = t(
        'sessionSearch.panel.truncated',
        'Some results or matching text were limited. Narrow your search for more precise results.'
      )
    }
  }
  if (response?.kind === 'results' && search.hits.length === 0 && !message) {
    message = t(
      'sessionSearch.panel.noMatches',
      'No matching sessions in the indexed history. Try another query or scope.'
    )
  }
  const skippedHosts =
    response?.kind === 'results' ? describeSkippedHosts(response.hosts ?? [], t) : null
  return (
    <>
      {(message || skippedHosts) && (
        <div
          className="space-y-2 border-b border-sidebar-border px-3 py-3 text-xs text-muted-foreground"
          role="status"
        >
          {message && <p>{message}</p>}
          {skippedHosts && <p>{skippedHosts}</p>}
          {needsLocalConsent ? (
            <>
              {saveError && (
                <p className="text-destructive">
                  {t('sessionSearch.panel.enableFailed', 'Could not enable search. Try again.')}
                </p>
              )}
              <Button size="xs" disabled={saving} onClick={() => void enable()}>
                {t('sessionSearch.panel.enable', 'Enable')}
              </Button>
            </>
          ) : !noAgents &&
            (error ||
              unavailable ||
              response?.kind === 'stale-cursor' ||
              response?.kind === 'malformed-cursor') ? (
            <Button size="xs" variant="outline" disabled={loading} onClick={onRetry}>
              {t('sessionSearch.panel.retry', 'Try again')}
            </Button>
          ) : null}
        </div>
      )}
      {children}
      {response?.kind === 'results' && response.page.hasMore && (
        <div className="border-t border-sidebar-border p-2">
          <Button
            className="w-full"
            variant="ghost"
            size="xs"
            disabled={loading}
            onClick={search.loadMore}
          >
            {t('sessionSearch.panel.loadMore', 'Load more matches')}
          </Button>
        </div>
      )}
    </>
  )
}
