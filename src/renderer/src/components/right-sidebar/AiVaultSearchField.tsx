import type React from 'react'
import { LoaderCircle, RefreshCw, Search, Sparkles, X } from 'lucide-react'
import type { AiVaultSearchScope } from '../../../../shared/ai-vault-session-search-scope'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { AiVaultSearchScopeControl } from './AiVaultSearchScopeControl'

export function aiVaultSearchUnconfiguredHint(): string {
  return translate(
    'auto.components.right.sidebar.AiVaultSearchField.65b6a40200',
    'Pick an agent in Settings -> Git -> Source Control AI.'
  )
}

export function AiVaultSearchField({
  query,
  loading,
  aiLoading,
  usedModel,
  aiAgentConfigured,
  searchScope,
  rgLoading,
  rgHitCount,
  onQueryChange,
  onSearchScopeChange,
  onAiSearch
}: {
  query: string
  loading: boolean
  aiLoading: boolean
  usedModel: boolean
  aiAgentConfigured: boolean
  searchScope: AiVaultSearchScope
  rgLoading: boolean
  rgHitCount: number | null
  onQueryChange: (query: string) => void
  onSearchScopeChange: (searchScope: AiVaultSearchScope) => void
  onAiSearch: () => void
}): React.JSX.Element {
  const queryReady = query.trim().length > 0
  const canRunAi = aiAgentConfigured && queryReady && !aiLoading
  const searchSessionsLabel = translate(
    'auto.components.right.sidebar.AiVaultPanel.searchSessions',
    'Search sessions'
  )
  const searchSessionsWithAiLabel = translate(
    'auto.components.right.sidebar.AiVaultPanel.searchSessionsWithAi',
    'Search sessions with AI'
  )
  let generateDisabledReason: string | undefined
  if (aiLoading) {
    generateDisabledReason = translate(
      'auto.components.right.sidebar.AiVaultPanel.searchingSessions',
      'Searching…'
    )
  } else if (!aiAgentConfigured) {
    generateDisabledReason = aiVaultSearchUnconfiguredHint()
  } else if (!queryReady) {
    generateDisabledReason = translate(
      'auto.components.right.sidebar.AiVaultPanel.enterQueryToSearchWithAi',
      'Enter a query to search sessions with AI.'
    )
  }

  return (
    <div className="mt-2">
      <div className="flex h-8 items-center gap-1.5 rounded-md border border-sidebar-border bg-input/50 px-2 focus-within:border-sidebar-ring focus-within:ring-[2px] focus-within:ring-sidebar-ring/30">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            // Why: IME Enter confirms a composition and must not submit AI search.
            if (event.nativeEvent.isComposing) {
              return
            }
            // Why: Enter is a shortcut when the field is focused; the labeled button is the primary AI affordance.
            if (event.key === 'Enter' && canRunAi) {
              event.preventDefault()
              onAiSearch()
            }
          }}
          placeholder={searchSessionsLabel}
          aria-label={searchSessionsLabel}
          className="min-w-0 flex-1 bg-transparent py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/50"
          spellCheck={false}
        />
        {rgLoading || loading ? (
          <LoaderCircle className="size-3 animate-spin text-muted-foreground" />
        ) : null}
        {query ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-5 rounded-sm text-muted-foreground hover:text-foreground"
            onClick={() => onQueryChange('')}
            aria-label={translate(
              'auto.components.right.sidebar.AiVaultPanel.clearSearch',
              'Clear search'
            )}
          >
            <X className="size-3" />
          </Button>
        ) : null}
      </div>
      <div className="mt-1.5">
        <AiVaultSearchScopeControl
          searchScope={searchScope}
          onSearchScopeChange={onSearchScopeChange}
        />
      </div>
      {rgLoading || rgHitCount !== null ? (
        <div className="mt-1 truncate text-[11px] text-muted-foreground">
          {rgLoading
            ? translate(
                'auto.components.right.sidebar.AiVaultPanel.searchingTranscripts',
                'Searching transcripts…'
              )
            : translate(
                'auto.components.right.sidebar.AiVaultPanel.transcriptHits',
                '{{count}} transcript hit',
                { count: rgHitCount ?? 0 }
              )}
        </div>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="mt-1.5 w-full"
        disabled={!canRunAi}
        aria-busy={aiLoading}
        onClick={() => {
          if (!canRunAi) {
            return
          }
          onAiSearch()
        }}
        title={generateDisabledReason ?? searchSessionsWithAiLabel}
        aria-label={searchSessionsWithAiLabel}
      >
        {aiLoading ? (
          <RefreshCw className="size-3 animate-spin" />
        ) : (
          <Sparkles className="size-3" />
        )}
        {aiLoading
          ? translate('auto.components.right.sidebar.AiVaultPanel.searchingSessions', 'Searching…')
          : translate('auto.components.right.sidebar.AiVaultPanel.searchWithAi', 'Search with AI')}
      </Button>
      {usedModel ? (
        <div className="mt-1 truncate text-[11px] text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.AiVaultPanel.aiRankedSessions',
            'AI ranked these sessions'
          )}
        </div>
      ) : null}
    </div>
  )
}
