import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, ChevronsUpDown, Sparkles, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  agentSearchSummaryMatches,
  normalizeAgentSearchQuery
} from '../../../../shared/agent-search-query'
import type { BuiltInTuiAgent, TuiAgent } from '../../../../shared/types'
import { AgentPickerListbox, type AgentPickerListboxItem } from '../agent/AgentPickerListbox'

/** What `set-default` accepts. Never `null` — a null default is a repair state the
 *  pane surfaces as an attention banner, not a selectable value here. */
export type DefaultAgentSelection = 'auto' | 'blank' | TuiAgent

export type AgentDefaultOption = {
  id: TuiAgent
  label: string
  /** Base harness for the row icon (custom ids have no icon of their own). */
  baseAgent: BuiltInTuiAgent
  /** Bounded searchable summary, built once per catalog revision by the caller. */
  searchSummary: string
}

/** The current default when it is disabled/tombstoned: kept selected with a
 *  warning for repair, but never offered as a fresh choice in the list. */
export type AgentDefaultStale = { id: TuiAgent; label: string; baseAgent: BuiltInTuiAgent }

export type AgentDefaultComboboxProps = {
  value: DefaultAgentSelection
  options: readonly AgentDefaultOption[]
  staleDefault?: AgentDefaultStale | null
  /** The persisted default is null (a repair state): render a placeholder trigger
   *  and check nothing, since null never resolves to Auto at launch. */
  unset?: boolean
  /** Move focus to the trigger on mount. The pane sets this for a repair-null
   *  default so opening Settings lands on the "Choose a default agent" combobox
   *  (plan §969). Mount-only: a later repair never steals focus. */
  autoFocusTrigger?: boolean
  onChange: (selection: DefaultAgentSelection) => void
  id?: string
}

const AUTO_VALUE = '__auto__'
const BLANK_VALUE = '__blank__'

type DefaultListRow = AgentPickerListboxItem & {
  selection: DefaultAgentSelection
  label: string
  icon: ReactNode
}

/** Normalize the query once, then match each option's precomputed summary. An
 *  empty query returns every option (no active filter). */
export function filterAgentDefaultOptions(
  options: readonly AgentDefaultOption[],
  rawQuery: string
): readonly AgentDefaultOption[] {
  const normalized = normalizeAgentSearchQuery(rawQuery)
  if (normalized === '') {
    return options
  }
  return options.filter((option) => agentSearchSummaryMatches(option.searchSummary, normalized))
}

export function AgentDefaultCombobox({
  value,
  options,
  staleDefault,
  unset,
  autoFocusTrigger,
  onChange,
  id
}: AgentDefaultComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxId = useId()
  // Mount-only: focus the repair-null default once on open, never on later
  // re-renders where a repair may have cleared `unset`.
  const shouldAutoFocus = useRef(autoFocusTrigger)
  useEffect(() => {
    if (shouldAutoFocus.current) {
      triggerRef.current?.focus()
    }
  }, [])
  const filtered = useMemo(() => filterAgentDefaultOptions(options, query), [options, query])
  const isStale = !unset && Boolean(staleDefault) && value === staleDefault?.id
  // When unset, nothing is truly selected, so no list row shows a check.
  const checkedValue = unset ? undefined : value

  const select = (selection: DefaultAgentSelection): void => {
    onChange(selection)
    setOpen(false)
    setQuery('')
  }

  // Auto and Blank are always offered (never filtered out); the searchable
  // options follow. Sentinel rows reserve their own values so the primitive can
  // track the active row and check the current selection uniformly.
  const rows = useMemo<DefaultListRow[]>(() => {
    const sentinels: DefaultListRow[] = [
      {
        value: AUTO_VALUE,
        selection: 'auto',
        label: translate('auto.components.settings.AgentDefaultCombobox.auto', 'Auto'),
        icon: <Sparkles className="size-3.5" />
      },
      {
        value: BLANK_VALUE,
        selection: 'blank',
        label: translate('auto.components.settings.AgentDefaultCombobox.blank', 'Blank Terminal'),
        icon: <Terminal className="size-3.5" />
      }
    ]
    const optionRows = filtered.map<DefaultListRow>((option) => ({
      value: option.id,
      selection: option.id,
      label: option.label,
      icon: <AgentIcon agent={option.baseAgent} />
    }))
    return [...sentinels, ...optionRows]
  }, [filtered])

  const initialActiveValue =
    unset || value === 'auto' ? AUTO_VALUE : value === 'blank' ? BLANK_VALUE : value

  return (
    <div className="space-y-2">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) {
            setQuery('')
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button
            ref={triggerRef}
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            className={cn(
              'h-9 w-full justify-between px-3 font-normal',
              isStale && 'border-amber-500/60',
              unset && 'border-amber-500/60'
            )}
          >
            <DefaultAgentTriggerLabel
              value={value}
              options={options}
              staleDefault={staleDefault}
              unset={unset}
            />
            <ChevronsUpDown className="size-3.5 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[var(--radix-popover-trigger-width)] min-w-[18rem] p-0"
        >
          <AgentPickerListbox
            items={rows}
            query={query}
            onQueryChange={setQuery}
            onSelect={(row) => select(row.selection)}
            initialActiveValue={initialActiveValue}
            listboxId={listboxId}
            listAriaLabel={translate(
              'auto.components.settings.AgentDefaultCombobox.listLabel',
              'Default agent options'
            )}
            searchPlaceholder={translate(
              'auto.components.settings.AgentDefaultCombobox.searchPlaceholder',
              'Search agents...'
            )}
            emptyLabel={translate(
              'auto.components.settings.AgentDefaultCombobox.noMatch',
              'No agents match your search.'
            )}
            renderItem={(row) => (
              <div className="flex items-center gap-2 px-3 py-1.5">
                <Check
                  className={cn(
                    'size-4',
                    checkedValue === row.selection ? 'opacity-100' : 'opacity-0'
                  )}
                />
                {row.icon}
                <span className="flex-1 truncate">{row.label}</span>
              </div>
            )}
            footer={
              <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.AgentDefaultCombobox.autoHint',
                  'Auto never selects a custom agent.'
                )}
              </div>
            }
          />
        </PopoverContent>
      </Popover>
      {isStale ? (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          {translate(
            'auto.components.settings.AgentDefaultCombobox.staleWarning',
            'This default is unavailable. Attended launches use the stock base harness command until you choose another agent.'
          )}
        </p>
      ) : null}
    </div>
  )
}

function DefaultAgentTriggerLabel({
  value,
  options,
  staleDefault,
  unset
}: {
  value: DefaultAgentSelection
  options: readonly AgentDefaultOption[]
  staleDefault?: AgentDefaultStale | null
  unset?: boolean
}): React.JSX.Element {
  // A null persisted default resolves to no_agent_selected at launch, never Auto,
  // so the trigger must read as an empty prompt, not a stock choice.
  if (unset) {
    return (
      <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 text-muted-foreground">
        <AlertTriangle className="size-3.5 text-amber-500" />
        <span className="truncate">
          {translate(
            'auto.components.settings.AgentDefaultCombobox.unsetPlaceholder',
            'Choose a default agent'
          )}
        </span>
      </span>
    )
  }
  if (staleDefault && value === staleDefault.id) {
    return (
      <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
        <AgentIcon agent={staleDefault.baseAgent} />
        <span className="truncate">{staleDefault.label}</span>
        <AlertTriangle className="size-3.5 text-amber-500" />
      </span>
    )
  }
  if (value === 'blank') {
    return (
      <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
        <Terminal className="size-3.5" />
        <span className="truncate">
          {translate('auto.components.settings.AgentDefaultCombobox.blank', 'Blank Terminal')}
        </span>
      </span>
    )
  }
  const option = value !== 'auto' ? options.find((entry) => entry.id === value) : undefined
  if (option) {
    return (
      <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
        <AgentIcon agent={option.baseAgent} />
        <span className="truncate">{option.label}</span>
      </span>
    )
  }
  return (
    <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
      <Sparkles className="size-3.5" />
      <span className="truncate">
        {translate('auto.components.settings.AgentDefaultCombobox.auto', 'Auto')}
      </span>
    </span>
  )
}
