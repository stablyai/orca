import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { shallow } from 'zustand/shallow'
import { sameAgentLaunchPickerModel } from '../tab-bar/new-tab-agent-menu-model'
import { memo, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
export const AgentLaunchPicker = memo(
  function AgentLaunchPicker({
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
    useUiLanguageRevision()
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
    const chosenSurface = draft?.surface ?? entry?.defaultSurface
    const surfaceLabel =
      entry && entry.surfaces.length > 1 && chosenSurface
        ? chosenSurface === 'chat'
          ? translate('agentPicker.chat', 'Chat')
          : translate('agentPicker.terminal', 'Terminal')
        : undefined
    const summary = [surfaceLabel, modelLabel, choices?.options?.effort].filter(Boolean).join(' · ')
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
                runLaunch={(row, draft, entry, surface) =>
                  onPick(
                    row.agent,
                    draft,
                    entry,
                    // Setup buttons pass a changed surface. A chat row with no draft is the chat choice.
                    surface ?? (!draft && row.kind === 'chat' ? 'chat' : undefined)
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
      </div>
    )
  },
  (a, b) =>
    sameAgentLaunchPickerModel(a.model, b.model) &&
    shallow({ ...a, model: undefined }, { ...b, model: undefined })
)
