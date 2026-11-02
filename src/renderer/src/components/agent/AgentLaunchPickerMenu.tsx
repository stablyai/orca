import { memo, useId, useRef, useState, type ComponentProps } from 'react'
import { Input } from '@/components/ui/input'
import {
  DropdownMenuItem,
  DropdownMenuShortcut,
  useDropdownMenuClose
} from '@/components/ui/dropdown-menu'
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

type Launch = (
  row: NewTabAgentMenuRow,
  draft?: AgentPickerDraft,
  entry?: AgentPickerEntry
) => boolean | void | Promise<boolean>

export function AgentLaunchPickerMenu({
  disabled,
  runLaunch,
  entries,
  hideSearch,
  onSelectAgent,
  shortcutLabels
}: {
  shortcutLabels?: ReadonlyMap<AgentPickerEntry['agent'], string>
  disabled?: boolean
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
  const closeMenu = useDropdownMenuClose()
  const unavailable = entry.rows.find((row) => row.kind === 'chat-unavailable')
  return (
    <AgentLaunchSetupButton
      submenu
      entry={entry}
      initial={initial}
      open={openSetup === setupId}
      replacedByAnotherSetup={openSetup !== null && openSetup !== setupId}
      disabled={disabled || !entry.surfaces.length}
      onOpenChange={(next) => {
        if (next || openSetup === setupId) {
          onSetupOpenChange(next ? setupId : null)
        }
        if (next) {
          onSelectAgent?.(entry.agent)
        }
      }}
      onUse={(draft) => {
        const result = runLaunch(pickerLaunchRow(entry, draft.surface), draft, entry)
        if (result !== false) {
          closeMenu()
        }
        return result
      }}
      renderAnchor={(trigger) => (
        <div
          data-agent-launch-row
          onClick={(event) => {
            event.preventDefault()
            if (disabled || !entry.surfaces.length) {
              return
            }
            const draft = initial
            const surface = draft?.surface ?? entry.defaultSurface
            const row = draft
              ? pickerLaunchRow(entry, surface)
              : (entry.rows.find((row) =>
                  surface === 'chat'
                    ? row.kind === 'chat'
                    : row.kind === 'terminal' || row.kind === 'cli'
                ) ?? pickerLaunchRow(entry, surface))
            const result = draft ? runLaunch(row, draft, entry) : runLaunch(row, undefined)
            if (result !== false) {
              closeMenu()
            }
          }}
          onKeyDown={(event) => {
            if (
              event.target === event.currentTarget &&
              (event.key === 'Enter' || event.key === ' ')
            ) {
              event.preventDefault()
              event.currentTarget.click()
            }
          }}
        >
          <AgentIcon agent={entry.agent} size={14} />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {shortcut ? <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut> : null}
          {unavailable?.kind === 'chat-unavailable' && !entry.surfaces.includes('chat') ? (
            <span className="text-xs text-muted-foreground">
              {chatUnavailableLabel(unavailable.reason)}
            </span>
          ) : null}
          {trigger}
        </div>
      )}
    />
  )
})
