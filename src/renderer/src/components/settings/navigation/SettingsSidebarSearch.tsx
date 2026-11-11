import type { KeyboardEvent, RefObject } from 'react'
import { Search, X } from 'lucide-react'
import type { RepoIcon } from '../../../../../shared/repo-icon'
import { useShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { ShortcutKeyCombo } from '../../ShortcutKeyCombo'
import { cn } from '@/lib/class-names'
import { RepoIconGlyph } from '../../repo/repo-icon'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { useTranslate } from '@/i18n/use-translate'
import { HighlightedText } from '../../worktree-jump/worktree-jump-palette-primitives'
import {
  getSettingsSearchTitleMatchRanges,
  type SettingsSearchResult
} from './settings-search-results'

type SettingsSearchFieldProps = {
  searchInputRef?: RefObject<HTMLInputElement | null>
  searchAutoFocus?: boolean
  query: string
  listboxId: string
  expanded: boolean
  activeOptionId: string | undefined
  onQueryChange: (query: string) => void
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
}

export function SettingsSearchField({
  searchInputRef,
  searchAutoFocus = false,
  query,
  listboxId,
  expanded,
  activeOptionId,
  onQueryChange,
  onKeyDown
}: SettingsSearchFieldProps): React.JSX.Element {
  const t = useTranslate()
  const searchShortcutCombos = useShortcutKeyComboDetails('settings.search')

  return (
    <div className="border-b border-worktree-sidebar-border px-3 py-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={searchInputRef}
          autoFocus={searchAutoFocus}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('auto.components.settings.SettingsSidebar.dbceaa8840', 'Search settings')}
          aria-label={t('auto.components.settings.SettingsSidebar.dbceaa8840', 'Search settings')}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={expanded ? listboxId : undefined}
          aria-activedescendant={activeOptionId}
          className="bg-background/60 pl-9 pr-14 text-[13px]"
        />
        {query === '' ? (
          <span className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 items-center">
            {searchShortcutCombos.map((combo) => (
              <ShortcutKeyCombo
                key={combo.keys.join('-')}
                keys={combo.keys}
                doubleTap={combo.doubleTap}
                className="inline-flex gap-0.5"
                separatorClassName="text-[10px] text-muted-foreground"
              />
            ))}
          </span>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              onQueryChange('')
              searchInputRef?.current?.focus()
            }}
            aria-label={t('settings.search.clear', 'Clear search')}
            className="absolute right-1.5 top-1/2 -translate-y-1/2"
          >
            <X />
          </Button>
        )}
      </div>
    </div>
  )
}

type SettingsSearchResultsListProps = {
  results: readonly SettingsSearchResult[]
  selectedIndex: number
  query: string
  listboxId: string
  getOptionId: (index: number) => string
  repoSectionById: ReadonlyMap<string, { repoIcon?: RepoIcon | null; badgeColor?: string }>
  groupTitleById: ReadonlyMap<string, string>
  hiddenResultCount: number
  onSelect: (result: SettingsSearchResult) => void
}

export function SettingsSearchResultsList({
  results: searchResults,
  selectedIndex: selectedResultIndex,
  query: searchQuery,
  listboxId,
  getOptionId,
  repoSectionById,
  groupTitleById,
  hiddenResultCount,
  onSelect
}: SettingsSearchResultsListProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek px-3 py-4">
      {searchResults.length > 0 ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label={t('settings.search.results', 'Settings search results')}
          className="space-y-0.5"
        >
          {searchResults.map((result, index) => {
            const isSelected = index === selectedResultIndex
            const repoSection = repoSectionById.get(result.section.id)
            const Icon = result.section.icon
            return (
              <button
                key={result.key}
                id={getOptionId(index)}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={isSelected}
                data-current={isSelected ? 'true' : undefined}
                // Keep focus in the search field so arrows keep moving through results.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(result)}
                className={cn(
                  'flex min-h-10 w-full items-start gap-2 rounded-lg px-3 py-1 text-left outline-none transition-colors duration-150',
                  isSelected
                    ? 'bg-worktree-sidebar-accent ring-1 ring-worktree-sidebar-ring/25'
                    : 'hover:bg-worktree-sidebar-accent/60'
                )}
              >
                {repoSection ? (
                  <RepoIconGlyph
                    repoIcon={repoSection.repoIcon}
                    color={repoSection.badgeColor}
                    className="mt-px size-4 shrink-0 text-muted-foreground"
                    iconClassName="size-3.5"
                  />
                ) : (
                  <Icon
                    className={cn(
                      'mt-px size-4 shrink-0',
                      isSelected
                        ? 'text-worktree-sidebar-accent-foreground'
                        : 'text-muted-foreground'
                    )}
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-[13px] leading-[18px] text-worktree-sidebar-foreground">
                    <HighlightedText
                      text={result.entry.title}
                      matchRanges={getSettingsSearchTitleMatchRanges(
                        result.entry.title,
                        searchQuery
                      )}
                    />
                  </span>
                  <span className="block break-words text-xs leading-4 text-muted-foreground">
                    {result.isPane
                      ? repoSection
                        ? t('auto.components.settings.SettingsSidebar.5c9669ff9c', 'Projects')
                        : (groupTitleById.get(result.section.group) ?? result.section.title)
                      : result.section.title}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      ) : null}
      {searchResults.length > 0 && hiddenResultCount > 0 ? (
        <p className="px-3 pt-3 text-xs text-muted-foreground">
          {t('settings.search.moreResults', '{{value0}} more · keep typing to narrow', {
            value0: hiddenResultCount
          })}
        </p>
      ) : null}
      {searchResults.length === 0 ? (
        <p role="status" className="px-3 py-6 text-center text-xs text-muted-foreground">
          {t('settings.search.noResults', 'No settings match “{{value0}}”', {
            value0: searchQuery.trim()
          })}
        </p>
      ) : null}
    </div>
  )
}
