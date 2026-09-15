import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { resolveAiVaultSearchSettings } from '../../../../shared/ai-vault-search-settings'
import type { useAiVaultPanelSearch } from './use-ai-vault-search'

export function AiVaultPanelSearch({
  search,
  noAgents,
  onDismiss,
  children
}: {
  search: ReturnType<typeof useAiVaultPanelSearch>
  noAgents: boolean
  onDismiss: () => void
  children: ReactNode
}) {
  const { localConsent, response, error, loading, retry: onRetry } = search
  const allHosts = !search.host
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
      onRetry()
    } catch {
      setSaveError(true)
    } finally {
      setSaving(false)
    }
  }
  const unavailable = response?.kind === 'unavailable' ? response.reason : null
  let message: string | null = null
  if (allHosts) {
    message = translate(
      'sessionSearch.panel.chooseHost',
      'Choose one computer to search its sessions.'
    )
  } else if (localConsent) {
    message = translate(
      'sessionSearch.panel.consent',
      'Enable full-text search? Orca builds an index on this computer from local agent transcripts, including full conversations and up to 3,072 characters per tool output. Content is not redacted. Authenticated paired clients can search it.'
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
  if (!search.searching) {
    return children
  }
  if (response?.kind === 'results' && search.hits.length === 0) {
    message = translate(
      'sessionSearch.panel.noMatches',
      'No matching sessions in the indexed history. Try another query or scope.'
    )
  }
  return (
    <>
      {message && (
        <div
          className="space-y-2 border-b border-sidebar-border px-3 py-3 text-xs text-muted-foreground"
          role="status"
        >
          <p>{message}</p>
          {localConsent && !allHosts ? (
            <>
              {saveError && (
                <p className="text-destructive">
                  {translate(
                    'sessionSearch.panel.enableFailed',
                    'Could not enable search. Try again.'
                  )}
                </p>
              )}
              <div className="flex gap-2">
                <Button size="xs" disabled={saving} onClick={() => void enable()}>
                  {translate('sessionSearch.panel.enable', 'Enable')}
                </Button>
                <Button size="xs" variant="ghost" disabled={saving} onClick={onDismiss}>
                  {translate('sessionSearch.panel.notNow', 'Not now')}
                </Button>
              </div>
            </>
          ) : !allHosts &&
            !noAgents &&
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
