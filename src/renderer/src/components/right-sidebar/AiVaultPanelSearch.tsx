import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { resolveAiVaultSearchSettings } from '../../../../shared/ai-vault-search-settings'
import type { AiVaultSearchHostOutcome } from '../../../../shared/ai-vault-search-types'
import { getExecutionHostLabel, parseExecutionHostId } from '../../../../shared/execution-host'
import type { useAiVaultPanelSearch } from './use-ai-vault-search'

// Short English like `getExecutionHostLabel`, which these read beside; null means the host answered.
function hostSkipReason(outcome: AiVaultSearchHostOutcome['outcome']): string | null {
  switch (outcome) {
    case 'searched':
      return null
    case 'stale':
      return 'index changed'
    case 'disabled':
      return 'search off'
    case 'not-ready':
      return 'not ready'
    case 'no-service':
      return 'unavailable'
    case 'unreachable':
      return 'unreachable'
    case 'scope-unknown':
      return 'scope not found there'
  }
}

// Neither reached the scope, so neither is evidence that some computer did.
const UNSETTLED_SCOPE_OUTCOMES = new Set<AiVaultSearchHostOutcome['outcome']>([
  'scope-unknown',
  'unreachable'
])

// A computer that simply lacks this project is the ordinary case, worth naming
// only when it is what explains an empty result.
function describeSkippedHosts(hosts: readonly AiVaultSearchHostOutcome[]): string | null {
  const anyResolved = hosts.some((entry) => !UNSETTLED_SCOPE_OUTCOMES.has(entry.outcome))
  const skipped = hosts.flatMap((entry) => {
    if (entry.outcome === 'scope-unknown' && anyResolved) {
      return []
    }
    const reason = hostSkipReason(entry.outcome)
    const label = getExecutionHostLabel(parseExecutionHostId(entry.executionHostId)?.id ?? null)
    return reason ? [`${label} (${reason})`] : []
  })
  return skipped.length > 0
    ? translate('sessionSearch.panel.hostsSkipped', 'Not searched: {{value0}}', {
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
    message = translate(
      'sessionSearch.panel.consent',
      'Enable full-text search? Orca builds an index on this computer from local agent transcripts, including full conversations and up to 3,072 characters per tool output. Content is not redacted. Authenticated paired clients can search it.'
    )
  } else if (search.hostSearchOff) {
    message = translate(
      'sessionSearch.panel.hostSearchOff',
      'Full-text search is off on this computer, so only session titles are matched.'
    )
  } else if (noAgents) {
    message = translate(
      'auto.components.right.sidebar.AiVaultPanel.noAgentsSelected',
      'No agents selected'
    )
  } else if (unavailable === 'disabled') {
    message = translate(
      'sessionSearch.panel.remoteDisabled',
      'Search is disabled on this computer. Enable transcript indexing on that computer to search its sessions.'
    )
  } else if (unavailable === 'not-ready') {
    message = translate(
      'sessionSearch.panel.notReady',
      'The search index is not ready yet. Try again shortly.'
    )
  } else if (unavailable === 'no-service') {
    message = translate(
      'sessionSearch.panel.noService',
      'Search is unavailable on this computer. It may need an Orca update or a runtime with search support.'
    )
  } else if (unavailable === 'scope-unknown') {
    message = translate(
      'sessionSearch.panel.scopeUnknown',
      'This computer does not have this workspace or project. Switch the scope to All to search everything on it.'
    )
  } else if (error) {
    message = translate(
      'sessionSearch.panel.failed',
      'Could not search this computer. Check its connection and try again.'
    )
  } else if (response?.kind === 'stale-cursor' || response?.kind === 'malformed-cursor') {
    message = translate(
      'sessionSearch.panel.changed',
      'The index changed while searching. Search again for current results.'
    )
  } else if (response?.kind === 'results') {
    if (
      response.truncated.candidates ||
      response.truncated.query ||
      response.truncated.snippets > 0
    ) {
      message = translate(
        'sessionSearch.panel.truncated',
        'Some results or matching text were limited. Narrow your search for more precise results.'
      )
    }
  }
  if (response?.kind === 'results' && search.hits.length === 0) {
    message = translate(
      'sessionSearch.panel.noMatches',
      'No matching sessions in the indexed history. Try another query or scope.'
    )
  }
  const skippedHosts =
    response?.kind === 'results' ? describeSkippedHosts(response.hosts ?? []) : null
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
                  {translate(
                    'sessionSearch.panel.enableFailed',
                    'Could not enable search. Try again.'
                  )}
                </p>
              )}
              <Button size="xs" disabled={saving} onClick={() => void enable()}>
                {translate('sessionSearch.panel.enable', 'Enable')}
              </Button>
            </>
          ) : !noAgents &&
            (error ||
              unavailable ||
              response?.kind === 'stale-cursor' ||
              response?.kind === 'malformed-cursor') ? (
            <Button size="xs" variant="outline" disabled={loading} onClick={onRetry}>
              {translate('sessionSearch.panel.retry', 'Try again')}
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
            {translate('sessionSearch.panel.loadMore', 'Load more matches')}
          </Button>
        </div>
      )}
    </>
  )
}
