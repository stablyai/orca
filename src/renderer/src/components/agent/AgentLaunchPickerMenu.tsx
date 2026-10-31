import { useId, useRef, useState, type PointerEvent } from 'react'
import { Input } from '@/components/ui/input'
import { DropdownMenuItem, DropdownMenuShortcut } from '@/components/ui/dropdown-menu'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { AgentLaunchSetupButton } from './AgentLaunchSetupButton'
import { chatUnavailableLabel } from '../tab-bar/tab-agent-row-presentation'
import type { NewTabAgentMenuRow } from '../../../../shared/agent-launch-picker-rows'
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
  // Radix row hover must not steal focus from the row's portaled setup or its nested controls.
  if (event.currentTarget.querySelector('[data-slot="popover-trigger"][aria-expanded="true"]')) {
    event.preventDefault()
  }
}

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
          initial={{
            agent: setup.entry.agent,
            surface: setup.entry.defaultSurface,
            choices: setup.choices
          }}
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

function AgentPickerMenuRow({
  entry,
  openSetup,
  onSetupOpenChange,
  label = entry.label,
  initial,
  disabled,
  runLaunch,
  shortcut,
  onSelectAgent
}: {
  entry: AgentPickerEntry
  openSetup: string | null
  onSetupOpenChange: (id: string | null) => void
  label?: string
  initial?: AgentPickerDraft
  disabled?: boolean
  runLaunch: Launch
  shortcut?: string
  onSelectAgent?: (agent: AgentPickerEntry['agent']) => void
}) {
  const setupId = useId()
  const item = useRef<HTMLDivElement>(null)
  const configured = useRef<AgentPickerDraft | undefined>(undefined)
  const unavailable = entry.rows.find((row) => row.kind === 'chat-unavailable')
  return (
    <AgentLaunchSetupButton
      entry={entry}
      initial={initial}
      open={openSetup === setupId}
      replacedByAnotherSetup={openSetup !== null && openSetup !== setupId}
      disabled={disabled}
      onOpenChange={(next) => {
        onSetupOpenChange(next ? setupId : null)
        if (next) {
          onSelectAgent?.(entry.agent)
        }
      }}
      onUse={(draft) => {
        configured.current = draft
        item.current?.click()
      }}
      renderAnchor={(trigger) => (
        <DropdownMenuItem
          ref={item}
          variant="launch"
          disabled={disabled || !entry.surfaces.length}
          onSelect={() => {
            const draft = configured.current ?? initial
            configured.current = undefined
            const surface = draft?.surface ?? entry.defaultSurface
            const row = draft
              ? pickerLaunchRow(entry, surface)
              : (entry.rows.find((row) =>
                  surface === 'chat'
                    ? row.kind === 'chat'
                    : row.kind === 'terminal' || row.kind === 'cli'
                ) ?? pickerLaunchRow(entry, surface))
            if (draft) {
              runLaunch(row, draft, entry)
            } else {
              runLaunch(row, undefined)
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') {
              event.preventDefault()
              item.current?.querySelector<HTMLButtonElement>('button')?.focus()
            }
          }}
          onPointerMove={keepSetupFocus}
          onPointerLeave={keepSetupFocus}
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
        </DropdownMenuItem>
      )}
    />
  )
}
