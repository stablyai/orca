import React from 'react'
import { ChevronDown, Settings2 } from 'lucide-react'
import type AgentCombobox from '@/components/agent/AgentCombobox'
import { AgentLaunchPicker } from '@/components/agent/AgentLaunchPicker'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import type { NewWorkspaceComposerCardProps } from './new-workspace-composer-card-props'

type NewWorkspaceComposerAgentSectionProps = Pick<
  NewWorkspaceComposerCardProps,
  | 'quickAgent'
  | 'agentPrompt'
  | 'onAgentPromptChange'
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
  agentPrompt,
  onAgentPromptChange,
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
  onToggleAdvanced,
  defaultTuiAgent,
  handleSetDefaultAgent
}: NewWorkspaceComposerAgentSectionProps): React.JSX.Element {
  const t = useTranslate()
  const initialPromptId = React.useId()
  return (
    <>
      <div className="min-w-0 space-y-1" data-contextual-tour-target="workspace-creation-agent">
        <div className="flex items-center justify-between gap-2">
          <label className="text-xs font-medium text-muted-foreground">
            {t('components.newWorkspace.agentOptional', 'Agent [Optional]')}
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
                aria-label={t(
                  'auto.components.NewWorkspaceComposerCard.ab63f25397',
                  'Open agent settings'
                )}
              >
                <Settings2 className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              {t('auto.components.NewWorkspaceComposerCard.ba64270bdb', 'Configure agents')}
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
          emptyLabel={t('auto.components.agent.AgentCombobox.986f946354', 'Blank Terminal')}
          defaultAgent={defaultTuiAgent}
          onSetDefault={handleSetDefaultAgent}
          onSelectBlankTerminal={() => onQuickAgentChange(null)}
          onPick={(agent, draft, entry) => onQuickAgentChange(agent, draft?.surface, draft, entry)}
        />
      </div>

      {quickAgent && !advancedLocked && (
        <div className="min-w-0 space-y-1">
          <label htmlFor={initialPromptId} className="text-xs font-medium text-muted-foreground">
            {t('auto.components.NewWorkspaceComposerCard.initialPrompt', 'Initial prompt')}{' '}
            <span className="text-muted-foreground/70">
              {t('auto.components.NewWorkspaceComposerCard.0c5d6a479c', '[Optional]')}
            </span>
          </label>
          <Textarea
            id={initialPromptId}
            rows={2}
            className="resize-none"
            value={agentPrompt}
            onChange={(event) => onAgentPromptChange(event.target.value)}
          />
        </div>
      )}

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
          {t('auto.components.NewWorkspaceComposerCard.f0470c7383', 'Advanced')}
          <ChevronDown
            className={cn('size-4 transition-transform', advancedOpen && 'rotate-180')}
          />
        </Button>
      </div>
    </>
  )
}
