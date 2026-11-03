import React from 'react'
import { ChevronDown, Settings2, Terminal } from 'lucide-react'
import type AgentCombobox from '@/components/agent/AgentCombobox'
import { AgentLaunchPicker } from '@/components/agent/AgentLaunchPicker'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { NewWorkspaceComposerCardProps } from './new-workspace-composer-card-props'

type NewWorkspaceComposerAgentSectionProps = Pick<
  NewWorkspaceComposerCardProps,
  | 'quickAgent'
  | 'agentSurfaceRows'
  | 'agentPickerDraft'
  | 'agentSetupDisabled'
  | 'selectedRepoIsGit'
  | 'selectedProjectId'
  | 'projectOptions'
  | 'onQuickAgentChange'
  | 'agentRows'
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
  agentSurfaceRows,
  agentPickerDraft,
  agentSetupDisabled,
  selectedRepoIsGit,
  selectedProjectId,
  projectOptions,
  onQuickAgentChange,
  onOpenAgentSettings,
  createDisabled,
  onCreate,
  advancedOpen,
  advancedLocked = false,
  onToggleAdvanced
}: NewWorkspaceComposerAgentSectionProps): React.JSX.Element {
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
                onClick={(event) => onOpenAgentSettings(event.currentTarget)}
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
        <AgentLaunchPicker
          model={agentSurfaceRows?.model ?? { state: 'loading', placeholderCount: 2 }}
          agent={quickAgent}
          value={agentPickerDraft}
          cli={agentSurfaceRows?.selection.cli === true}
          setupDisabled={agentSetupDisabled}
          matchTriggerWidth={
            selectedRepoIsGit &&
            projectOptions?.find((option) => option.id === selectedProjectId)?.kind !==
              'project-group'
          }
          onOpenAgentSettings={onOpenAgentSettings}
          onTriggerEnter={createDisabled ? undefined : onCreate}
          emptyLabel={translate('auto.components.agent.AgentCombobox.986f946354', 'Blank Terminal')}
          onPick={(agent, draft, entry) => onQuickAgentChange(agent, draft?.surface, draft, entry)}
        >
          <DropdownMenuItem onSelect={() => onQuickAgentChange(null)}>
            <Terminal className="size-3.5" />
            {translate('auto.components.agent.AgentCombobox.986f946354', 'Blank Terminal')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </AgentLaunchPicker>
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
