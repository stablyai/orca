import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, Folder, FolderGit2, GitBranch, Search, Server, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { keybindingMatchesAction } from '../../../../../../shared/keybindings/matching'
import type { KeybindingOverrides } from '../../../../../../shared/keybindings/types'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import {
  sameAgentJournalWorkTarget,
  type AgentJournalWorkTarget
} from '../../../../../../shared/agent-session/work-target/agent-session-work-target'
import {
  filterBotWorkTargetTree,
  rowMatchesBotWorkTargetQuery,
  type BotWorkTargetTreeRow
} from './bot-work-target-tree'
import { useBotWorkTargetCatalog } from './use-bot-work-target-catalog'

function getNextSelectableIndex(
  rows: readonly BotWorkTargetTreeRow[],
  startIndex: number,
  step: 1 | -1
): number {
  if (rows.length === 0) {
    return -1
  }
  for (let offset = 1; offset <= rows.length; offset += 1) {
    const candidate = (startIndex + offset * step + rows.length) % rows.length
    if (!rows[candidate]?.unavailableReason) {
      return candidate
    }
  }
  return -1
}

function firstSelectableIndex(
  rows: readonly BotWorkTargetTreeRow[],
  selectedTarget: AgentJournalWorkTarget | null,
  query: string
): number {
  if (query.trim()) {
    const directMatch = rows.findIndex(
      (row) => !row.unavailableReason && rowMatchesBotWorkTargetQuery(row, query)
    )
    if (directMatch !== -1) {
      return directMatch
    }
  }
  if (selectedTarget) {
    const selectedIndex = rows.findIndex(
      (row) => !row.unavailableReason && sameAgentJournalWorkTarget(row.target, selectedTarget)
    )
    if (selectedIndex !== -1) {
      return selectedIndex
    }
  }
  return rows.findIndex((row) => !row.unavailableReason)
}

function RowIcon({ row }: { row: BotWorkTargetTreeRow }): React.JSX.Element {
  if (row.kind === 'workspace') {
    return row.workspaceKind === 'folder' ? (
      <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
    ) : (
      <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
    )
  }
  return row.repoKind === 'folder' ? (
    <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
  ) : (
    <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
  )
}

/** Mounted only while the popover is open so closed composers pay zero catalog subscriptions. */
export function NativeChatWorkTargetPickerBody({
  botHostId,
  platform,
  keybindings,
  triggerLabel,
  selectedTarget,
  rowsOverride,
  searchInputRef,
  onSelectTarget,
  closeAndReturnFocus
}: {
  botHostId: ExecutionHostId
  platform: NodeJS.Platform
  keybindings: KeybindingOverrides
  triggerLabel: string
  selectedTarget: AgentJournalWorkTarget | null
  rowsOverride?: readonly BotWorkTargetTreeRow[]
  searchInputRef: React.RefObject<HTMLInputElement | null>
  onSelectTarget: (target: AgentJournalWorkTarget | null) => void
  closeAndReturnFocus: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const liveRows = useBotWorkTargetCatalog(rowsOverride ? null : botHostId, !rowsOverride)
  const allRows = rowsOverride ?? liveRows
  const [query, setQuery] = useState('')
  const filteredRows = useMemo(() => filterBotWorkTargetTree(allRows, query), [allRows, query])
  const [highlightedRowId, setHighlightedRowId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()

  // Derive the active row index during render so filter/selection changes never need an effect setState.
  const activeIndex = useMemo(() => {
    if (highlightedRowId !== null) {
      const matched = filteredRows.findIndex(
        (row) => row.id === highlightedRowId && !row.unavailableReason
      )
      if (matched !== -1) {
        return matched
      }
    }
    return firstSelectableIndex(filteredRows, selectedTarget, query)
  }, [filteredRows, highlightedRowId, query, selectedTarget])

  useEffect(() => {
    if (activeIndex < 0) {
      return
    }
    const optionEl = listRef.current?.querySelector<HTMLElement>(
      `[data-work-target-index="${activeIndex}"]`
    )
    optionEl?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const handleSelectRow = useCallback(
    (row: BotWorkTargetTreeRow) => {
      if (row.unavailableReason) {
        return
      }
      onSelectTarget(row.target)
      closeAndReturnFocus()
    },
    [closeAndReturnFocus, onSelectTarget]
  )

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      if (event.key === 'Enter') {
        event.preventDefault()
      }
      return
    }
    if (
      keybindingMatchesAction(
        'chat.pickWorkTarget',
        {
          key: event.key,
          code: event.code,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey
        },
        platform,
        keybindings
      )
    ) {
      event.preventDefault()
      event.stopPropagation()
      closeAndReturnFocus()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      const next = getNextSelectableIndex(filteredRows, activeIndex, 1)
      setHighlightedRowId(next >= 0 ? (filteredRows[next]?.id ?? null) : null)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      const next = getNextSelectableIndex(filteredRows, Math.max(0, activeIndex), -1)
      setHighlightedRowId(next >= 0 ? (filteredRows[next]?.id ?? null) : null)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      const candidate = activeIndex >= 0 ? filteredRows[activeIndex] : undefined
      if (candidate && !candidate.unavailableReason) {
        handleSelectRow(candidate)
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeAndReturnFocus()
    }
  }

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
        <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <input
          ref={searchInputRef}
          type="text"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setHighlightedRowId(null)
          }}
          onKeyDown={handleSearchKeyDown}
          role="combobox"
          aria-expanded
          aria-controls={listboxId}
          aria-activedescendant={
            activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined
          }
          aria-label={t(
            'components.native-chat.workTarget.searchPlaceholder',
            'Filter projects and workspaces…'
          )}
          placeholder={t(
            'components.native-chat.workTarget.searchPlaceholder',
            'Filter projects and workspaces…'
          )}
          className="w-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none"
        />
        {query ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('components.native-chat.workTarget.clearSearch', 'Clear search')}
            onClick={() => {
              setQuery('')
              setHighlightedRowId(null)
              searchInputRef.current?.focus()
            }}
            className="size-5 shrink-0"
          >
            <X className="size-3" />
          </Button>
        ) : null}
      </div>
      <div
        ref={listRef}
        id={listboxId}
        role="listbox"
        aria-label={triggerLabel}
        className="scrollbar-sleek max-h-72 overflow-y-auto p-1"
      >
        {allRows.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t(
              'components.native-chat.workTarget.emptyCatalog',
              'No registered projects or workspaces available.'
            )}
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t(
              'components.native-chat.workTarget.noMatches',
              'No matching projects or workspaces.'
            )}
          </div>
        ) : (
          filteredRows.map((row, index) => {
            const isSelected = sameAgentJournalWorkTarget(row.target, selectedTarget)
            const isHighlighted = index === activeIndex
            const isUnavailable = row.unavailableReason !== undefined
            const showHostBadge = row.hostId !== LOCAL_EXECUTION_HOST_ID || row.ambiguousName
            const unavailableText =
              row.unavailableReason === 'offline'
                ? t('components.native-chat.workTarget.offline', 'Offline')
                : row.unavailableReason === 'ssh-project-unsupported'
                  ? t('components.native-chat.workTarget.existingOnly', 'Pick a workspace')
                  : t('components.native-chat.workTarget.otherHost', 'Other host')
            const unavailableTitle =
              row.unavailableReason === 'ssh-project-unsupported'
                ? t(
                    'components.native-chat.workTarget.sshProjectUnsupportedTitle',
                    'New workspaces cannot be created on SSH Git projects. Select an existing workspace below.'
                  )
                : undefined
            return (
              <div
                key={row.id}
                id={`${listboxId}-option-${index}`}
                role="option"
                data-work-target-index={index}
                data-work-target-row-id={row.id}
                aria-selected={isSelected}
                aria-disabled={isUnavailable || undefined}
                title={unavailableTitle}
                onMouseEnter={() => {
                  if (!isUnavailable) {
                    setHighlightedRowId(row.id)
                  }
                }}
                onMouseDown={(event) => {
                  // Keep keyboard focus inside the popover search input while clicking rows.
                  event.preventDefault()
                }}
                onClick={() => handleSelectRow(row)}
                style={{ paddingLeft: `${8 + row.depth * 14}px` }}
                className={cn(
                  'flex items-center gap-2 rounded-md py-1.5 pr-2 text-xs select-none',
                  isUnavailable
                    ? 'cursor-not-allowed opacity-50'
                    : 'cursor-pointer hover:bg-accent/60',
                  isHighlighted && !isUnavailable && 'bg-accent text-accent-foreground'
                )}
              >
                <RowIcon row={row} />
                <span className="min-w-0 flex-1 truncate">
                  <span className={cn(row.kind === 'project' ? 'font-medium' : 'font-normal')}>
                    {row.displayName}
                  </span>
                  {row.detail ? (
                    <span className="ml-1.5 font-mono text-2xs text-muted-foreground">
                      {row.detail}
                    </span>
                  ) : null}
                </span>
                {showHostBadge ? (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded bg-secondary/70 px-1.5 py-0.5 text-2xs text-muted-foreground">
                    <Server className="size-2.5 shrink-0" aria-hidden />
                    <span className="max-w-24 truncate">{row.hostLabel}</span>
                  </span>
                ) : null}
                {isUnavailable ? (
                  <span className="shrink-0 text-2xs text-muted-foreground">{unavailableText}</span>
                ) : isSelected ? (
                  <Check className="size-3.5 shrink-0 text-foreground" aria-hidden />
                ) : null}
              </div>
            )
          })
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border bg-secondary/20 px-2.5 py-1.5 text-2xs text-muted-foreground">
        <span>
          {t('components.native-chat.workTarget.footerHint', 'Applies to the next message only')}
        </span>
        {selectedTarget ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              onSelectTarget(null)
              closeAndReturnFocus()
            }}
          >
            {t('components.native-chat.workTarget.clearAction', 'Clear')}
          </Button>
        ) : null}
      </div>
    </>
  )
}
