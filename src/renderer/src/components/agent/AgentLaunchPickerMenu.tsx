import { terminalPendingReason } from '../tab-bar/new-tab-agent-menu-model'
import { memo, useId, useRef, useState, type ComponentProps, type PointerEvent } from 'react'
import { Input } from '@/components/ui/input'
import {
  DropdownMenuItem,
  DropdownMenuShortcut,
  useCloseDropdownMenu
} from '@/components/ui/dropdown-menu'
import { keepLaunchItemHighlight, LAUNCH_ROW_ATTRIBUTE } from './agent-launch-row'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { AgentLaunchSetupButton } from './AgentLaunchSetupButton'
import { chatUnavailableLabel } from '../tab-bar/tab-agent-row-presentation'
import type { NewTabAgentMenuRow } from '../../../../shared/agent-launch-picker-rows'
import {
  useAgentPickerInventoryEntries,
  type AgentPickerInventorySource
} from './use-agent-launch-picker-inventory'
import {
  searchAgentPickerSetups,
  type AgentPickerDraft,
  type AgentPickerEntry,
  type AgentPickerSurface
} from '../../../../shared/agent-launch-picker'

export function pickerLaunchRow(
  entry: AgentPickerEntry,
  surface: AgentPickerSurface
): NewTabAgentMenuRow {
  return {
    agent: entry.agent,
    kind: surface === 'chat' ? 'chat' : 'cli',
    executionHostId: entry.rows[0]?.executionHostId
  }
}

type Launch = (row: NewTabAgentMenuRow, draft?: AgentPickerDraft, entry?: AgentPickerEntry) => void

function keepSetupFocus(event: PointerEvent<HTMLDivElement>) {
  // Radix row hover must not steal focus from the row's portaled setup or the controls beside it.
  if (
    event.currentTarget.parentElement?.querySelector(
      '[data-slot="popover-trigger"][aria-expanded="true"]'
    )
  ) {
    event.preventDefault()
  }
}

export function AgentLaunchPickerMenu({
  disabled,
  runLaunch,
  entries,
  hideSearch,
  onSelectAgent,
  shortcutLabels,
  terminalPending
}: {
  shortcutLabels?: ReadonlyMap<AgentPickerEntry['agent'], string>
  disabled?: boolean
  /** The host is still connecting, so terminal launches wait; chat launches do not. */
  terminalPending?: boolean
  runLaunch: Launch
  entries: AgentPickerEntry[]
  hideSearch?: boolean
  onSelectAgent?: (agent: AgentPickerEntry['agent']) => void
}) {
  const [query, setQuery] = useState('')
  const [openSetup, setOpenSetup] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const setups = searchAgentPickerSetups(entries, query)
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const visible = entries.filter((entry) =>
    words.every((word) => `${entry.agent} ${entry.label}`.toLowerCase().includes(word))
  )
  return (
    <div ref={root} data-agent-launch-picker="true">
      {!hideSearch ? (
        <div className="p-1">
          <Input
            value={query}
            autoFocus
            placeholder={translate('agentPicker.search', 'Search agents and setups…')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                return
              }
              event.stopPropagation()
              if (event.key === 'Enter' || event.key === 'ArrowDown') {
                event.preventDefault()
                const first = root.current?.querySelector<HTMLElement>(
                  '[role="menuitem"]:not([data-disabled])'
                )
                if (event.key === 'Enter') {
                  first?.click()
                } else {
                  first?.focus()
                }
              }
            }}
          />
        </div>
      ) : null}
      {setups.map((setup) => (
        <AgentPickerMenuRow
          key={`${setup.entry.agent}:${setup.model.id}:${setup.choices.options?.effort ?? ''}`}
          entry={setup.entry}
          openSetup={openSetup}
          onSetupOpenChange={setOpenSetup}
          label={setup.label}
          initialModel={setup.choices.model}
          initialEffort={setup.choices.options?.effort}
          onSelectAgent={onSelectAgent}
          disabled={disabled}
          terminalPending={terminalPending}
          runLaunch={runLaunch}
        />
      ))}
      {visible.map((entry) => (
        <AgentPickerMenuRow
          key={entry.agent}
          entry={entry}
          openSetup={openSetup}
          onSetupOpenChange={setOpenSetup}
          disabled={disabled}
          terminalPending={terminalPending}
          runLaunch={runLaunch}
          onSelectAgent={onSelectAgent}
          shortcut={shortcutLabels?.get(entry.agent)}
        />
      ))}
      {!visible.length && !setups.length ? (
        <DropdownMenuItem disabled>
          {translate(
            'auto.components.agent.AgentCombobox.579c768bde',
            'No agents match your search.'
          )}
        </DropdownMenuItem>
      ) : null}
    </div>
  )
}

// Subscribe here so inventory updates do not re-render the tab bar.
export function SubscribedAgentLaunchPickerMenu({
  inventory,
  ...props
}: Omit<ComponentProps<typeof AgentLaunchPickerMenu>, 'entries'> & {
  inventory: AgentPickerInventorySource
}) {
  const entries = useAgentPickerInventoryEntries(inventory)
  return <AgentLaunchPickerMenu {...props} entries={entries} />
}

// Why: catalog and seed reads land one agent at a time after the menu opens; only that row re-renders.
const AgentPickerMenuRow = memo(function AgentPickerMenuRow({
  entry,
  openSetup,
  onSetupOpenChange,
  label = entry.label,
  initialModel,
  initialEffort,
  disabled,
  terminalPending,
  runLaunch,
  shortcut,
  onSelectAgent
}: {
  entry: AgentPickerEntry
  openSetup: string | null
  onSetupOpenChange: (id: string | null) => void
  label?: string
  initialModel?: string
  initialEffort?: string
  disabled?: boolean
  terminalPending?: boolean
  runLaunch: Launch
  shortcut?: string
  onSelectAgent?: (agent: AgentPickerEntry['agent']) => void
}) {
  useUiLanguageRevision()
  const initial: AgentPickerDraft | undefined = initialModel
    ? {
        agent: entry.agent,
        surface: entry.defaultSurface,
        choices: {
          model: initialModel,
          ...(initialEffort ? { options: { effort: initialEffort } } : {})
        }
      }
    : undefined
  const setupId = useId()
  const item = useRef<HTMLDivElement>(null)
  const closeMenu = useCloseDropdownMenu()
  const unavailable = entry.rows.find((row) => row.kind === 'chat-unavailable')
  const pendingReason = (surface: AgentPickerSurface) =>
    terminalPendingReason(terminalPending, pickerLaunchRow(entry, surface))
  const defaultUnavailable = pendingReason(entry.defaultSurface)
  const launchDisabled = disabled || !entry.surfaces.length
  // One reason per row: why its primary action can't run now.
  const reason =
    defaultUnavailable ??
    (unavailable?.kind === 'chat-unavailable' && !entry.surfaces.includes('chat')
      ? chatUnavailableLabel(unavailable.reason)
      : null)
  const reasonId = `${setupId}-reason`
  // The row's own launch and a launch configured in its setup share this guarded path.
  const launch = (draft: AgentPickerDraft | undefined): boolean => {
    const surface = draft?.surface ?? entry.defaultSurface
    if (pendingReason(surface)) {
      return false
    }
    const row = draft
      ? pickerLaunchRow(entry, surface)
      : (entry.rows.find((row) =>
          surface === 'chat' ? row.kind === 'chat' : row.kind === 'terminal' || row.kind === 'cli'
        ) ?? pickerLaunchRow(entry, surface))
    if (draft) {
      runLaunch(row, draft, entry)
    } else {
      runLaunch(row, undefined)
    }
    return true
  }
  return (
    <AgentLaunchSetupButton
      entry={entry}
      initial={initial}
      open={openSetup === setupId}
      replacedByAnotherSetup={openSetup !== null && openSetup !== setupId}
      disabled={disabled}
      terminalBlocked={terminalPending}
      onOpenChange={(next) => {
        onSetupOpenChange(next ? setupId : null)
        if (next) {
          onSelectAgent?.(entry.agent)
        }
      }}
      onUse={(draft) => {
        if (launch(draft)) {
          closeMenu()
        }
      }}
      renderAnchor={(trigger) => (
        <div
          {...LAUNCH_ROW_ATTRIBUTE}
          className="flex items-center rounded-[7px] pr-2 has-[[data-highlighted]]:bg-black/8 dark:has-[[data-highlighted]]:bg-white/14"
        >
          <DropdownMenuItem
            ref={item}
            variant="launch-row"
            className="min-w-0 flex-1"
            disabled={launchDisabled}
            // A waiting launch stays focusable so arrow keys still reach it and Configure.
            aria-disabled={launchDisabled || !!defaultUnavailable || undefined}
            aria-describedby={reason ? reasonId : undefined}
            onSelect={(event) => {
              if (!launch(initial)) {
                event.preventDefault()
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') {
                event.preventDefault()
                item.current?.parentElement?.querySelector<HTMLButtonElement>('button')?.focus()
              }
            }}
            onPointerMove={keepSetupFocus}
            onPointerLeave={(event) => {
              keepSetupFocus(event)
              keepLaunchItemHighlight(event)
            }}
          >
            <AgentIcon agent={entry.agent} size={14} />
            {/* Why flex-auto: the name keeps its width and the reason truncates first. */}
            <span className="min-w-0 flex-auto truncate">{label}</span>
            {shortcut ? <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut> : null}
            {reason ? (
              <span
                id={reasonId}
                className="min-w-0 shrink-[4] truncate text-xs text-muted-foreground"
              >
                {reason}
              </span>
            ) : null}
          </DropdownMenuItem>
          {trigger}
        </div>
      )}
    />
  )
})
