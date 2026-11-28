import React from 'react'
import { ChevronRight } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { SwitchIndicator } from '@/components/ui/switch'
import {
  getGitHubPRStateChips,
  getGitHubPRWhoChips
} from '@/components/task-page/task-page-localized-options'
import {
  deriveGitHubPRStateChip,
  deriveGitHubPRWhoChip,
  gitHubPRWhoChange,
  gitHubPRWhoPreset
} from '@/components/task-page/github/listing/task-page-pr-chips'
import {
  buildSectionRows,
  type PRFilterChange,
  type SectionKey
} from '@/components/github/PRFilterSections'
import type { TaskViewPresetId } from '../../../../shared/ui-chrome/ui-chrome-types'
import type { ParsedTaskQuery } from '../../../../shared/work-items/task-query'
import { useTranslate } from '@/i18n/use-translate'

function ValueRowContent({
  label,
  value
}: {
  label: string
  value: string | null
}): React.JSX.Element {
  return (
    <>
      <span className="shrink-0 whitespace-nowrap">{label}</span>
      <span className="ml-auto flex min-w-0 items-center gap-2 text-muted-foreground">
        {value ? <span className="min-w-0 truncate">{value}</span> : null}
        <ChevronRight className="size-[15px] shrink-0 text-muted-foreground" />
      </span>
    </>
  )
}

export function PRFilterValueMenu({
  parsed,
  reviewerActive,
  reviewerKind,
  onChange,
  onPick,
  onClearAll,
  onSetDefaultPreset
}: {
  parsed: ParsedTaskQuery
  reviewerActive: string | null
  reviewerKind: 'requested' | 'reviewed-by'
  onChange: (change: PRFilterChange) => void
  onPick: (s: SectionKey) => void
  onClearAll: (() => void) | null
  onSetDefaultPreset?: (preset: TaskViewPresetId) => void
}): React.JSX.Element {
  const t = useTranslate()
  const stateOptions = getGitHubPRStateChips()
  const whoOptions = getGitHubPRWhoChips()
  const activeState = deriveGitHubPRStateChip(parsed)
  const activeWho = deriveGitHubPRWhoChip(parsed)
  const activeStateLabel = stateOptions.find((option) => option.id === activeState)?.label ?? null
  const activeWhoLabel = whoOptions.find((option) => option.id === activeWho)?.label ?? null
  const rows = buildSectionRows(parsed, 'prs', reviewerActive, reviewerKind, t)

  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger hideChevron>
          <ValueRowContent
            label={t('auto.components.github.PRFilterDropdowns.13b3ac0a84', 'Status')}
            value={activeStateLabel}
          />
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="min-w-[140px]">
          <DropdownMenuRadioGroup
            value={activeState}
            onValueChange={(value) => {
              const option = stateOptions.find((entry) => entry.id === value)
              // Why: re-applying the active state would only rewrite the query and refetch the same rows.
              if (option && activeState !== option.id) {
                onChange({ state: option.id })
              }
            }}
          >
            {stateOptions.map(({ id, label }) => (
              <DropdownMenuRadioItem
                key={id}
                value={id}
                indicator="check"
                onSelect={(event) => event.preventDefault()}
                onContextMenu={
                  id === 'open' && onSetDefaultPreset
                    ? (event) => {
                        event.preventDefault()
                        onSetDefaultPreset('prs')
                      }
                    : undefined
                }
              >
                {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuSub>
        <DropdownMenuSubTrigger hideChevron>
          <ValueRowContent
            label={t('auto.components.github.PRFilterDropdowns.show', 'Show')}
            value={activeWhoLabel}
          />
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="min-w-[140px]">
          <DropdownMenuRadioGroup
            value={activeWho ?? ''}
            onValueChange={(value) => {
              const option = whoOptions.find((entry) => entry.id === value)
              if (option && activeWho !== option.id) {
                onChange(gitHubPRWhoChange(option.id))
              }
            }}
          >
            {whoOptions.map(({ id, label }) => (
              <DropdownMenuRadioItem
                key={id}
                value={id}
                indicator="check"
                onSelect={(event) => event.preventDefault()}
                onContextMenu={
                  activeState === 'open' && onSetDefaultPreset
                    ? (event) => {
                        event.preventDefault()
                        onSetDefaultPreset(gitHubPRWhoPreset(id))
                      }
                    : undefined
                }
              >
                {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuItem
        role="menuitemcheckbox"
        aria-checked={parsed.draft}
        onSelect={(event) => {
          event.preventDefault()
          onChange({ draft: !parsed.draft })
        }}
      >
        <span className="shrink-0 whitespace-nowrap">
          {t('auto.components.github.PRFilterSections.b930de7194', 'Draft only')}
        </span>
        <SwitchIndicator checked={parsed.draft} size="compact" className="ml-auto" />
      </DropdownMenuItem>

      <DropdownMenuSeparator />

      {rows.map((row) => (
        <DropdownMenuItem
          key={row.key}
          onSelect={(event) => {
            event.preventDefault()
            onPick(row.key)
          }}
        >
          <ValueRowContent label={row.label} value={row.value} />
        </DropdownMenuItem>
      ))}

      {onClearAll ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onClearAll}>
            <span className="text-muted-foreground">
              {t('auto.components.github.PRFilterSections.30ebb6ca44', 'Clear all filters')}
            </span>
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  )
}
