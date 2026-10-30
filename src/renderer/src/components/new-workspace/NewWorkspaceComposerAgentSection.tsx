import React, { useState } from 'react'
import { ChevronDown, Info, Plus, Settings2, X } from 'lucide-react'
import { toast } from 'sonner'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { AgentLaunchSetupPanel } from '@/components/agent/AgentLaunchSetupPanel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getAgentLabel } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { ComposerAgentEntry } from '@/hooks/composer-state/composer-agent-entries'
import {
  MAX_COMPOSER_AGENT_ROWS,
  type NewWorkspaceComposerCardProps
} from './new-workspace-composer-card-props'
import type { AgentPickerDraft, AgentPickerEntry } from '../../../../shared/agent-launch-picker'
import type { TuiAgent } from '../../../../shared/tui-agent'

const COMBOBOX_TRIGGER_CLASS =
  'h-9 w-full min-w-0 border-input text-sm focus:border-ring focus:ring-[3px] focus:ring-ring/50'

/** Show enough of the flags to tell same-harness rows apart without opening the setup panel. */
function argumentsSummary(text: string): string {
  const tokens = text.split(/\s+/).filter(Boolean)
  return tokens.length > 2 ? `${tokens.slice(0, 2).join(' ')}…` : tokens.join(' ')
}

type NewWorkspaceComposerAgentSectionProps = Pick<
  NewWorkspaceComposerCardProps,
  | 'quickAgent'
  | 'agentEntries'
  | 'onAgentEntryChange'
  | 'onAddAgentEntry'
  | 'onRemoveAgentEntry'
  | 'agentEntriesLocked'
  | 'agentSurfaceRows'
  | 'onQuickAgentChange'
  | 'agentRows'
  | 'quickSetupOnly'
  | 'onQuickSetupOnlySelect'
  | 'onOpenAgentSettings'
  | 'createDisabled'
  | 'onCreate'
  | 'advancedOpen'
  | 'onToggleAdvanced'
> & {
  advancedLocked?: boolean
  visibleQuickAgents: React.ComponentProps<typeof AgentCombobox>['agents']
  defaultTuiAgent: React.ComponentProps<typeof AgentCombobox>['defaultAgent']
  handleSetDefaultAgent: (
    next: Parameters<NonNullable<React.ComponentProps<typeof AgentCombobox>['onSetDefault']>>[0]
  ) => void
}

export function NewWorkspaceComposerAgentSection({
  quickAgent,
  agentEntries,
  onAgentEntryChange,
  onAddAgentEntry,
  onRemoveAgentEntry,
  agentEntriesLocked = false,
  agentSurfaceRows,
  onQuickAgentChange,
  quickSetupOnly = false,
  onQuickSetupOnlySelect,
  onOpenAgentSettings,
  createDisabled,
  onCreate,
  advancedOpen,
  advancedLocked = false,
  onToggleAdvanced,
  visibleQuickAgents,
  defaultTuiAgent,
  handleSetDefaultAgent
}: NewWorkspaceComposerAgentSectionProps): React.JSX.Element {
  const [openSetupEntryId, setOpenSetupEntryId] = useState<string | null>(null)
  // Composer state always supplies rows; callers without them keep the legacy single picker.
  const rows = agentEntries && agentEntries.length > 0 ? agentEntries : null
  const atCap = rows !== null && rows.length >= MAX_COMPOSER_AGENT_ROWS
  const comboboxProps = {
    agents: visibleQuickAgents,
    value: quickAgent,
    onValueChange: (agent: TuiAgent | null) => onQuickAgentChange(agent),
    allowBlankTerminal: true as const,
    onOpenManageAgents: onOpenAgentSettings,
    defaultAgent: defaultTuiAgent,
    onSetDefault: handleSetDefaultAgent,
    clearSelection: onQuickSetupOnlySelect
      ? { cleared: quickSetupOnly, onClear: onQuickSetupOnlySelect }
      : undefined,
    allowNarrowTrigger: true,
    triggerClassName: COMBOBOX_TRIGGER_CLASS,
    onTriggerEnter: createDisabled ? undefined : onCreate
  }
  const labelFor = (agent: TuiAgent): string =>
    visibleQuickAgents.find((candidate) => candidate.id === agent)?.label ?? getAgentLabel(agent)

  // Row 0 shows the quick pick, so its draft follows detection-driven changes without an effect.
  const draftForRow = (entry: ComposerAgentEntry, index: number): AgentPickerDraft =>
    index === 0 && quickAgent !== null && quickAgent !== entry.draft.agent
      ? { ...entry.draft, agent: quickAgent, choices: {}, arguments: undefined }
      : entry.draft
  const rowShowsDetails = (entry: ComposerAgentEntry, index: number): boolean => {
    const draft = draftForRow(entry, index)
    return (
      (rows?.length ?? 0) > 1 ||
      Boolean(draft.arguments?.trim()) ||
      entry.displayName.trim().length > 0
    )
  }
  const changeRowAgent = (
    entry: ComposerAgentEntry,
    index: number,
    agent: TuiAgent | null
  ): void => {
    if (index === 0) {
      onQuickAgentChange(agent)
    }
    if (agent === null || agent === entry.draft.agent) {
      return
    }
    // Flags belong to the previous harness, so a harness switch starts from a bare draft.
    onAgentEntryChange?.(entry.id, {
      draft: { ...entry.draft, agent, choices: {}, arguments: undefined }
    })
  }
  const addAgentEntry = (): void => {
    if (agentEntriesLocked) {
      return
    }
    if (atCap) {
      toast.error(
        translate(
          'auto.components.new.workspace.NewWorkspaceComposerAgentSection.0af78c86a9',
          'You can add up to {{max}} agents per workspace.',
          { max: MAX_COMPOSER_AGENT_ROWS }
        )
      )
      return
    }
    // Added rows repeat row 0's harness; persist a detection-driven row 0 pick before copying it.
    const row0 = rows?.[0]
    if (row0 && quickAgent !== null && quickAgent !== row0.draft.agent) {
      onAgentEntryChange?.(row0.id, {
        draft: { ...row0.draft, agent: quickAgent, choices: {}, arguments: undefined }
      })
    }
    onAddAgentEntry?.()
  }

  const renderRow = (entry: ComposerAgentEntry, index: number): React.JSX.Element => {
    const draft = draftForRow(entry, index)
    const lockedRow = agentEntriesLocked && index > 0
    const label = labelFor(draft.agent)
    const details = rowShowsDetails(entry, index)
    const argumentsText = draft.arguments?.trim() ?? ''
    const pickerEntry: AgentPickerEntry = {
      agent: draft.agent,
      label,
      rows: [],
      surfaces: ['terminal'],
      defaultSurface: 'terminal',
      terminal: {},
      structured: {},
      arguments: argumentsText || null,
      catalog: { origin: 'unknown' },
      ownerKey: entry.id
    }
    return (
      <div key={entry.id} className="min-w-0 space-y-1" data-agent-entry-row={index}>
        <div className="flex min-w-0 items-center gap-1">
          <div className="min-w-0 flex-1">
            {index === 0 ? (
              <AgentCombobox
                {...comboboxProps}
                onValueChange={(agent: TuiAgent | null) => changeRowAgent(entry, index, agent)}
                surfaceRows={agentSurfaceRows}
              />
            ) : (
              <AgentCombobox
                agents={visibleQuickAgents}
                value={entry.draft.agent}
                onValueChange={(agent: TuiAgent) => changeRowAgent(entry, index, agent)}
                allowBlankTerminal={false}
                onOpenManageAgents={onOpenAgentSettings}
                defaultAgent={defaultTuiAgent}
                onSetDefault={handleSetDefaultAgent}
                allowNarrowTrigger
                triggerClassName={COMBOBOX_TRIGGER_CLASS}
                disabled={lockedRow}
              />
            )}
          </div>
          {details ? (
            <Popover
              open={openSetupEntryId === entry.id}
              onOpenChange={(open) => setOpenSetupEntryId(open ? entry.id : null)}
            >
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  disabled={lockedRow}
                  aria-label={translate('agentPicker.configure', 'Configure {{agent}}', {
                    agent: label
                  })}
                  className="size-7 shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
                >
                  <Settings2 className="size-3.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                side="bottom"
                align="end"
                sideOffset={6}
                className="flex w-104 max-w-(--radix-popover-content-available-width) max-h-(--radix-popover-content-available-height) flex-col"
              >
                <div className="min-h-0 overflow-y-auto scrollbar-sleek">
                  <AgentLaunchSetupPanel
                    key={`${entry.id}:${draft.agent}`}
                    entry={pickerEntry}
                    initial={draft}
                    disabled={lockedRow}
                    onUse={(next) => {
                      onAgentEntryChange?.(entry.id, { draft: next })
                      setOpenSetupEntryId(null)
                    }}
                  />
                </div>
              </PopoverContent>
            </Popover>
          ) : null}
          {rows !== null && rows.length > 1 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={translate(
                'auto.components.new.workspace.NewWorkspaceComposerAgentSection.44216cf70c',
                'Remove agent'
              )}
              className="size-7 shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
              onClick={() => onRemoveAgentEntry?.(entry.id)}
            >
              <X className="size-3.5" />
            </Button>
          ) : null}
        </div>
        {details ? (
          <div className="flex min-w-0 items-center gap-1.5">
            {argumentsText ? (
              <span
                title={argumentsText}
                data-agent-entry-flags="true"
                className="min-w-0 shrink truncate rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 font-mono text-2xs text-muted-foreground"
              >
                {argumentsSummary(argumentsText)}
              </span>
            ) : null}
            <Input
              value={entry.displayName}
              maxLength={60}
              disabled={lockedRow}
              placeholder={label}
              aria-label={translate(
                'auto.components.new.workspace.NewWorkspaceComposerAgentSection.59552ca156',
                'Agent name'
              )}
              onChange={(event) =>
                onAgentEntryChange?.(entry.id, { displayName: event.target.value })
              }
              className="h-7 w-2/5 min-w-24 flex-none text-xs md:text-xs"
            />
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <>
      <div className="min-w-0 space-y-1" data-contextual-tour-target="workspace-creation-agent">
        <div className="flex items-center justify-between gap-2">
          <label className="text-xs font-medium text-muted-foreground">
            {translate('components.newWorkspace.agentOptional', 'Agent [Optional]')}
          </label>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={onOpenAgentSettings}
                tabIndex={-1}
                className="size-5 shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
                aria-label={translate(
                  'auto.components.NewWorkspaceComposerCard.ab63f25397',
                  'Open agent settings'
                )}
              >
                <Settings2 className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              {translate('auto.components.NewWorkspaceComposerCard.ba64270bdb', 'Configure agents')}
            </TooltipContent>
          </Tooltip>
        </div>
        {rows === null ? (
          <AgentCombobox {...comboboxProps} surfaceRows={agentSurfaceRows} />
        ) : (
          <div className="space-y-1.5">
            {rows.map(renderRow)}
            {agentEntriesLocked && rows.length > 1 ? (
              <div
                role="status"
                className="flex items-start gap-1.5 rounded-md border border-border/70 bg-muted/30 px-2.5 py-1.5 text-2xs text-muted-foreground"
              >
                <Info className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {translate(
                    'auto.components.new.workspace.NewWorkspaceComposerAgentSection.ea6ee390a8',
                    'Multiple agents apply only to local git workspaces; later rows will be ignored'
                  )}
                </span>
              </div>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={agentEntriesLocked}
              aria-disabled={atCap || undefined}
              onClick={addAgentEntry}
              className="h-8 w-full border-dashed text-xs text-muted-foreground"
            >
              <Plus className="size-3.5" />
              {translate(
                'auto.components.new.workspace.NewWorkspaceComposerAgentSection.2b3158e96c',
                'Add agent'
              )}
            </Button>
          </div>
        )}
      </div>

      <div className="!mb-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onToggleAdvanced}
          disabled={advancedLocked}
          aria-expanded={advancedOpen}
          className="-ml-2 text-xs focus-visible:ring-inset"
        >
          {translate('auto.components.NewWorkspaceComposerCard.f0470c7383', 'Advanced')}
          <ChevronDown
            className={cn('size-4 transition-transform', advancedOpen && 'rotate-180')}
          />
        </Button>
      </div>
    </>
  )
}
