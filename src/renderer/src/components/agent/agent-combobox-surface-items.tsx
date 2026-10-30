import React, { useState } from 'react'
import { CommandItem, CommandSeparator } from '@/components/ui/command'
import { AgentIcon, getAgentCatalog, type AgentCatalogEntry } from '@/lib/agent-catalog'
import { searchAgentPickerEntries } from '@/lib/agent-picker-search'
import type { AgentLaunchSurface } from '@/lib/agent-session-launch-plan'
import type { NewTabAgentMenuRow } from '@/lib/new-tab-agent-menu-rows'
import type { NewTabAgentMenuModel } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import {
  chatUnavailableLabel,
  rowId,
  rowLabel,
  rowTitle
} from '@/components/tab-bar/tab-agent-row-presentation'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { resolveAgentMenuSelection } from '@/lib/agent-menu-selection'
import { renderAgentComboboxItem } from './agent-combobox-items'
import { AgentSurfaceLaunchButton } from './AgentSurfaceLaunchButton'

/** The "+" menu's rows in the picker: a chat row picks the chat, its terminal button the CLI. */
export type AgentComboboxSurfaceRows = {
  model: NewTabAgentMenuModel
  /** The user's explicit pick for the selected agent; absent follows the agent's own row. */
  surface?: AgentLaunchSurface
  selection: ReturnType<typeof resolveAgentMenuSelection>
  contextKey?: string
  onPick: (agent: TuiAgent, surface: AgentLaunchSurface) => void
}

// Nothing launches until the form is submitted, so the picker says "start", not "launch".
function terminalPickTitle(label: string): string {
  return translate('components.agentCombobox.startInTerminal', 'Start {{value0}} in a terminal', {
    value0: label
  })
}

const PLACEHOLDER_WIDTHS = ['w-3/5', 'w-1/2', 'w-2/3', 'w-2/5', 'w-3/4', 'w-1/3', 'w-4/5', 'w-1/4']

export function visibleSurfaceRows(
  model: NewTabAgentMenuModel,
  agents: readonly AgentCatalogEntry[],
  query: string
): NewTabAgentMenuRow[] {
  if (model.state !== 'settled') {
    return []
  }
  const matching = searchAgentPickerEntries(agents, query)
  return query.trim()
    ? matching.flatMap((agent) => model.rows.filter((row) => row.agent === agent.id))
    : model.rows.filter((row) => matching.some((agent) => row.agent === agent.id))
}

/** cmdk values for the surface list: the selected agent's row, and the row a query highlights. */
export function surfaceCommandValues(
  model: NewTabAgentMenuModel,
  picker: {
    query: string
    value: TuiAgent | null
    blankValue: string
    blankMatchesQuery: boolean
  }
): { rows: NewTabAgentMenuRow[]; selected: string | null; highlighted: string } {
  // Disabled rows are listed with their reason, so every agent is searched, not only pickable ones.
  const rows = visibleSurfaceRows(model, getAgentCatalog(), picker.query)
  const selected =
    surfaceRowValue(visibleSurfaceRows(model, getAgentCatalog(), ''), picker.value) ?? null
  const first = rows.find((row) => row.kind !== 'chat-unavailable')
  const highlighted = !picker.query.trim()
    ? (selected ?? picker.blankValue)
    : picker.blankMatchesQuery
      ? picker.blankValue
      : first
        ? rowId(first)
        : ''
  return { rows, selected, highlighted }
}

/** The row that carries the selected agent: its chat row when it has one, so the lit button shows. */
export function surfaceRowValue(
  rows: readonly NewTabAgentMenuRow[],
  agent: TuiAgent | null
): string | undefined {
  const own = rows.filter((row) => row.agent === agent && row.kind !== 'chat-unavailable')
  const row = own.find((candidate) => candidate.kind === 'chat') ?? own[0]
  return row ? rowId(row) : undefined
}

/** A chat row's terminal button runs the agent's CLI, so only a detected CLI gets one. */
const rowOffersTerminal = (model?: NewTabAgentMenuModel, row?: NewTabAgentMenuRow): boolean =>
  row?.kind === 'chat' &&
  model?.state === 'settled' &&
  model.detection.detectedIds?.includes(row.agent) === true

/** cmdk keeps focus in the search box, so ArrowRight arms the highlighted row's terminal button. */
export function useSurfaceRowArming(
  rows: readonly NewTabAgentMenuRow[],
  commandValue: string,
  pick: (agent: TuiAgent, surface: AgentLaunchSurface) => void,
  interaction: { key: string; model?: NewTabAgentMenuModel }
): { armedValue: string | null; onKeyDown: (event: React.KeyboardEvent) => void } {
  const [armed, setArmed] = useState<string | null>(null)
  const key = JSON.stringify([interaction.key, commandValue])
  const [previousKey, setPreviousKey] = useState(key)
  if (previousKey !== key) {
    setPreviousKey(key)
    setArmed(null)
  }
  const armedValue = previousKey === key ? armed : null
  const onKeyDown = (event: React.KeyboardEvent): void => {
    const row = rows.find((candidate) => rowId(candidate) === commandValue)
    const input = event.target instanceof HTMLInputElement ? event.target : null
    const caretAtEnd = !input || input.selectionStart === input.value.length
    if (event.key === 'ArrowRight' && rowOffersTerminal(interaction.model, row) && caretAtEnd) {
      event.preventDefault()
      setArmed(commandValue)
    } else if (event.key === 'Enter' && armedValue !== null && row) {
      // Stopped so cmdk does not also select the row and start a chat.
      event.preventDefault()
      pick(row.agent, 'terminal')
    } else if (armedValue !== null && !['Shift', 'Meta', 'Control', 'Alt'].includes(event.key)) {
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
      }
      setArmed(null)
    }
  }
  return { armedValue, onKeyDown }
}

export function SurfaceAgentItems({
  surfaceRows,
  rows,
  value,
  armedValue,
  defaultAgent,
  onSetDefault
}: {
  surfaceRows: AgentComboboxSurfaceRows
  rows: readonly NewTabAgentMenuRow[]
  value: TuiAgent | null
  armedValue: string | null
  defaultAgent?: TuiAgent | 'blank' | null
  onSetDefault?: (agent: TuiAgent) => void
}): React.ReactNode {
  const { model, onPick } = surfaceRows
  if (model.state === 'loading') {
    // Why: rows fill in once every answer is known, instead of reshuffling under the pointer.
    return PLACEHOLDER_WIDTHS.slice(0, model.placeholderCount).map((width) => (
      <CommandItem
        key={width}
        value={`loading:${width}`}
        disabled
        aria-label={translate(
          'auto.components.tab.bar.QuickLaunchButton.agentsLoading',
          'Loading agents'
        )}
      >
        <span aria-hidden="true" className="flex h-[1lh] flex-1 items-center">
          <span className={cn('h-2 rounded-full bg-muted', width)} />
        </span>
      </CommandItem>
    ))
  }
  const pickedValue = surfaceRowValue(rows, value)
  const terminalPicked = surfaceRows.selection.cli
  return rows.map((row, index) => {
    const id = rowId(row)
    const label = rowLabel(row)
    const startsCliGroup = row.kind === 'cli' && index > 0 && rows[index - 1]?.kind !== 'cli'
    const unavailable = row.kind === 'chat-unavailable'
    const pressed = row.kind === 'chat' && id === pickedValue && terminalPicked
    const agentLabel = rowLabel({ ...row, kind: 'chat' })
    return (
      <React.Fragment key={id}>
        {startsCliGroup ? <CommandSeparator /> : null}
        {renderAgentComboboxItem({
          key: id,
          itemValue: unavailable ? `unavailable:${row.agent}` : id,
          isChecked: id === pickedValue,
          isDefault: defaultAgent === row.agent,
          onSelect: () => onPick(row.agent, row.kind === 'chat' ? 'chat' : 'terminal'),
          onSetDefault: onSetDefault && !unavailable ? () => onSetDefault(row.agent) : undefined,
          icon: <AgentIcon agent={row.agent} />,
          label,
          disabled: unavailable,
          title: unavailable
            ? undefined
            : row.kind === 'chat'
              ? rowTitle(row, agentLabel)
              : terminalPickTitle(agentLabel),
          trailing: unavailable ? (
            <span className="shrink-0 text-muted-foreground">
              {chatUnavailableLabel(row.reason)}
            </span>
          ) : rowOffersTerminal(model, row) ? (
            <AgentSurfaceLaunchButton
              surface="terminal"
              title={terminalPickTitle(agentLabel)}
              aria-pressed={pressed}
              className={cn(
                'hover:bg-background [[data-selected=true]_&]:opacity-100',
                (pressed || armedValue === id) && 'bg-background opacity-100'
              )}
              // Keeps focus in the search box; the click picks the CLI, not the row.
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation()
                onPick(row.agent, 'terminal')
              }}
            />
          ) : null
        })}
      </React.Fragment>
    )
  })
}
