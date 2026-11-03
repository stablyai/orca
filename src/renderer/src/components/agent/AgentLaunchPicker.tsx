import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { shallow } from 'zustand/shallow'
import { sameAgentLaunchPickerModel } from '../tab-bar/new-tab-agent-menu-model'
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import AgentSettingsDialog, { restoreAgentSettingsInvoker } from './AgentSettingsDialog'
import { getAgentSessionOptionLaunchCatalog } from '../../../../shared/agent-session/options/agent-session-option-catalog'
import { AgentSettingsMenuItem } from './AgentSettingsMenuItem'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { AgentIcon, getAgentLabel } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { rowLabel } from '../tab-bar/tab-agent-row-presentation'
import type { NewTabAgentMenuModel } from '../tab-bar/use-new-tab-agent-menu-rows'
import { useAgentPickerDraftScope } from './AgentLaunchSetupButton'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import { useAgentLaunchPickerInventory } from './use-agent-launch-picker-inventory'
import {
  agentPickerDraft,
  type AgentPickerDraft,
  type AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { agentPickerPanelArguments } from '../../../../shared/agent-launch/picker/agent-launch-picker-arguments'

/** Forms own selection and dispatch; rows and setup remain the same as the new-tab menu. */
export const AgentLaunchPicker = memo(
  function AgentLaunchPicker({
    model,
    entries: suppliedEntries,
    triggerLabel,
    draftScope,
    worktreeId,
    value,
    draftForEntry,
    agent,
    disabled,
    setupDisabled,
    matchTriggerWidth,
    emptyLabel,
    cli,
    children,
    onTriggerEnter,
    onCatalogOpen,
    onOpenAgentSettings,
    onPick
  }: {
    model: NewTabAgentMenuModel
    entries?: AgentPickerEntry[]
    triggerLabel?: string
    draftScope?: object
    worktreeId?: string
    value?: AgentPickerDraft
    draftForEntry?: (entry: AgentPickerEntry) => AgentPickerDraft
    agent: AgentPickerEntry['agent'] | null
    disabled?: boolean
    setupDisabled?: boolean
    matchTriggerWidth?: boolean
    emptyLabel?: string
    /** True when this launch is the terminal and a chat exists, so the closed field says "(CLI)". */
    cli?: boolean
    children?: ReactNode
    onTriggerEnter?: () => void
    /** Supplied entries own their catalogs; this says which agent's menu the user is viewing. */
    onCatalogOpen?: (agent: AgentPickerEntry['agent']) => void
    onOpenAgentSettings?: (invoker: HTMLButtonElement) => void
    onPick: (
      agent: AgentPickerEntry['agent'],
      draft?: AgentPickerDraft,
      entry?: AgentPickerEntry,
      surface?: AgentPickerDraft['surface']
    ) => void
  }) {
    useUiLanguageRevision()
    const ownDraftScope = useAgentPickerDraftScope()
    const [settingsOpen, setSettingsOpen] = useState(false)
    const trigger = useRef<HTMLButtonElement>(null)
    const openAgentSettings = useCallback(() => {
      setOpen(false)
      if (onOpenAgentSettings) {
        onOpenAgentSettings(trigger.current!)
      } else {
        setSettingsOpen(true)
      }
    }, [onOpenAgentSettings])
    const [open, setOpen] = useState(false)
    const [selected, setSelected] = useState<AgentPickerEntry['agent']>()
    const observedEntries = useAgentLaunchPickerInventory(
      worktreeId,
      model,
      open && !setupDisabled && !suppliedEntries,
      selected ?? agent ?? undefined
    )
    const entries = suppliedEntries ?? observedEntries
    const catalogAgent = open && suppliedEntries ? (agent ?? undefined) : undefined
    useEffect(() => {
      if (catalogAgent) {
        onCatalogOpen?.(catalogAgent)
      }
    }, [catalogAgent, onCatalogOpen])
    const entry = entries.find((entry) => entry.agent === agent)
    const draft = entry ? (value ?? draftForEntry?.(entry)) : undefined
    const choices = entry
      ? agentPickerPanelArguments(entry, draft ?? agentPickerDraft(entry)).choices
      : undefined
    const modelLabel =
      (entry
        ? getAgentSessionOptionLaunchCatalog(entry.agent)?.models.find(
            (model) => model.id === choices?.model
          )?.label
        : undefined) ?? choices?.model
    const summary = [modelLabel, choices?.options?.effort].filter(Boolean).join(' · ')
    const agentLabel = agent
      ? cli
        ? rowLabel({ kind: 'cli', agent })
        : getAgentLabel(agent)
      : (emptyLabel ?? translate('agentPicker.select', 'Select agent'))
    return (
      <div className="space-y-2">
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              ref={trigger}
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
                {triggerLabel ?? agentLabel}
                {!triggerLabel && agent && summary ? (
                  <span className="text-muted-foreground"> · {summary}</span>
                ) : null}
              </span>
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className={
              matchTriggerWidth
                ? 'w-(--radix-dropdown-menu-trigger-width) min-w-(--radix-dropdown-menu-trigger-width)'
                : 'min-w-64'
            }
          >
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
                onSelectAgent={(agent) => {
                  setSelected(agent)
                  if (suppliedEntries) {
                    onCatalogOpen?.(agent)
                  }
                }}
                runLaunch={(row, draft, entry, surface) =>
                  onPick(
                    row.agent,
                    draft,
                    entry,
                    // Re-selecting an agent preserves the form's surface; a new chat row chooses Chat.
                    surface ??
                      (!draft && row.agent !== agent && row.kind === 'chat' ? 'chat' : undefined)
                  )
                }
              />
            ) : (
              <DropdownMenuItem disabled>
                {translate('agentPicker.select', 'Select agent')}
              </DropdownMenuItem>
            )}
            <AgentSettingsMenuItem onSelect={openAgentSettings} />
          </DropdownMenuContent>
        </DropdownMenu>
        {settingsOpen && !onOpenAgentSettings ? (
          <AgentSettingsDialog
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            onCloseAutoFocus={(event) => restoreAgentSettingsInvoker(event, trigger.current)}
          />
        ) : null}
      </div>
    )
  },
  (a, b) =>
    sameAgentLaunchPickerModel(a.model, b.model) &&
    shallow({ ...a, model: undefined }, { ...b, model: undefined })
)
