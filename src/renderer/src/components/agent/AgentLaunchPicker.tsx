import { useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { AgentIcon, getAgentLabel } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import type { NewTabAgentMenuModel } from '../tab-bar/use-new-tab-agent-menu-rows'
import { useAgentPickerDraftScope } from './AgentLaunchSetupButton'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import { useAgentLaunchPickerInventory } from './use-agent-launch-picker-inventory'
import {
  agentPickerDraft,
  type AgentPickerDraft,
  type AgentPickerEntry
} from '../../../../shared/agent-launch-picker'
import { agentPickerPanelArguments } from '../../../../shared/agent-launch-picker-arguments'

/** Forms own selection and dispatch; rows and setup remain the same as the new-tab menu. */
export function AgentLaunchPicker({
  model,
  draftScope,
  worktreeId,
  value,
  draftForEntry,
  agent,
  disabled,
  setupDisabled,
  emptyLabel,
  children,
  onTriggerEnter,
  onPick
}: {
  model: NewTabAgentMenuModel
  draftScope?: object
  worktreeId?: string
  value?: AgentPickerDraft
  draftForEntry?: (entry: AgentPickerEntry) => AgentPickerDraft
  agent: AgentPickerEntry['agent'] | null
  disabled?: boolean
  setupDisabled?: boolean
  emptyLabel?: string
  children?: ReactNode
  onTriggerEnter?: () => void
  onPick: (
    agent: AgentPickerEntry['agent'],
    draft?: AgentPickerDraft,
    entry?: AgentPickerEntry,
    surface?: AgentPickerDraft['surface']
  ) => void
}) {
  const ownDraftScope = useAgentPickerDraftScope()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<AgentPickerEntry['agent']>()
  const entries = useAgentLaunchPickerInventory(
    worktreeId,
    model,
    open && !setupDisabled,
    selected ?? agent ?? undefined
  )
  const entry = entries.find((entry) => entry.agent === agent)
  const draft = entry ? (value ?? draftForEntry?.(entry)) : undefined
  const choices = entry
    ? agentPickerPanelArguments(entry, draft ?? agentPickerDraft(entry)).choices
    : undefined
  const modelLabel =
    (entry && entry.catalog.origin !== 'unknown'
      ? entry.catalog.models.find((model) => model.id === choices?.model)?.label
      : undefined) ?? choices?.model
  const summary = [modelLabel, choices?.options?.effort].filter(Boolean).join(' · ')
  return (
    <div className="space-y-2">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            aria-label={translate('agentPicker.select', 'Select agent')}
            variant="outline"
            className="w-full min-w-0"
            disabled={disabled || model.state !== 'settled'}
            onKeyDown={(event) => {
              if (!open && event.key === 'Enter' && onTriggerEnter) {
                event.preventDefault()
                event.stopPropagation()
                onTriggerEnter()
              }
            }}
          >
            {agent ? <AgentIcon agent={agent} size={14} /> : null}
            <span className="min-w-0 flex-1 truncate text-left">
              {agent
                ? getAgentLabel(agent)
                : (emptyLabel ?? translate('agentPicker.select', 'Select agent'))}
              {agent && summary ? (
                <span className="text-muted-foreground"> · {summary}</span>
              ) : null}
            </span>
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-64">
          {children}
          {model.state === 'settled' ? (
            <AgentLaunchPickerMenu
              draftScope={draftScope ?? ownDraftScope}
              model={model}
              entries={entries}
              value={value}
              draftForEntry={draftForEntry}
              mode="select"
              disabled={disabled}
              setupDisabled={setupDisabled}
              onSelectAgent={setSelected}
              runLaunch={(row, draft, entry) =>
                onPick(
                  row.agent,
                  draft,
                  entry,
                  draft?.surface ?? (row.kind === 'chat' ? 'chat' : 'terminal')
                )
              }
            />
          ) : (
            <DropdownMenuItem disabled>
              {translate('agentPicker.select', 'Select agent')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {entry && entry.surfaces.length > 1 ? (
        <ToggleGroup
          type="single"
          value={draft?.surface ?? entry.defaultSurface}
          disabled={disabled}
          aria-label={translate('agentPicker.openIn', 'Open in')}
          className="grid w-full grid-cols-2"
          onValueChange={(surface) => {
            if (surface === 'chat' || surface === 'terminal') {
              onPick(
                entry.agent,
                { ...(draft ?? agentPickerDraft(entry)), surface },
                entry,
                surface
              )
            }
          }}
        >
          <ToggleGroupItem value="chat">{translate('agentPicker.chat', 'Chat')}</ToggleGroupItem>
          <ToggleGroupItem value="terminal">
            {translate('agentPicker.terminal', 'Terminal')}
          </ToggleGroupItem>
        </ToggleGroup>
      ) : null}
    </div>
  )
}
