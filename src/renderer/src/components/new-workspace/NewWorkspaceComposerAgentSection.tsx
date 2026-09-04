import React from 'react'
import { ChevronDown, Settings2 } from 'lucide-react'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { AgentLaunchProfile } from '../../../../shared/agent-launch-profile/agent-launch-profile'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { NewWorkspaceComposerCardProps } from './new-workspace-composer-card-props'

type NewWorkspaceComposerAgentSectionProps = Pick<
  NewWorkspaceComposerCardProps,
  | 'quickAgent'
  | 'onQuickAgentChange'
  | 'quickLaunchProfileId'
  | 'onQuickLaunchProfileChange'
  | 'onOpenAgentSettings'
  | 'createDisabled'
  | 'onCreate'
  | 'advancedOpen'
  | 'onToggleAdvanced'
> & {
  /** Profiles of the selected agent; the picker stays hidden while this is empty. */
  quickLaunchProfiles: readonly AgentLaunchProfile[]
  visibleQuickAgents: React.ComponentProps<typeof AgentCombobox>['agents']
  defaultTuiAgent: React.ComponentProps<typeof AgentCombobox>['defaultAgent']
  handleSetDefaultAgent: (
    next: Parameters<NonNullable<React.ComponentProps<typeof AgentCombobox>['onSetDefault']>>[0]
  ) => void
}

// Why: Radix Select rejects an empty value, and a profile id is a lowercase dash slug, so an
// underscored token can never collide with one.
const DEFAULT_LAUNCH_VALUE = '__default_launch__'

export function NewWorkspaceComposerAgentSection({
  quickAgent,
  onQuickAgentChange,
  quickLaunchProfileId,
  onQuickLaunchProfileChange,
  quickLaunchProfiles,
  onOpenAgentSettings,
  createDisabled,
  onCreate,
  advancedOpen,
  onToggleAdvanced,
  visibleQuickAgents,
  defaultTuiAgent,
  handleSetDefaultAgent
}: NewWorkspaceComposerAgentSectionProps): React.JSX.Element {
  return (
    <>
      <div className="min-w-0 space-y-1" data-contextual-tour-target="workspace-creation-agent">
        <div className="flex items-center justify-between gap-2">
          <label className="text-xs font-medium text-muted-foreground">
            {translate('auto.components.NewWorkspaceComposerCard.01d1e8f601', 'Agent')}
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
        <AgentCombobox
          agents={visibleQuickAgents}
          value={quickAgent}
          onValueChange={onQuickAgentChange}
          onOpenManageAgents={onOpenAgentSettings}
          defaultAgent={defaultTuiAgent}
          onSetDefault={handleSetDefaultAgent}
          allowNarrowTrigger
          triggerClassName="h-9 w-full min-w-0 border-input text-sm focus:border-ring focus:ring-[3px] focus:ring-ring/50"
          onTriggerEnter={createDisabled ? undefined : onCreate}
        />
        {quickLaunchProfiles.length > 0 ? (
          <Select
            value={quickLaunchProfileId ?? DEFAULT_LAUNCH_VALUE}
            onValueChange={(value) =>
              onQuickLaunchProfileChange(value === DEFAULT_LAUNCH_VALUE ? null : value)
            }
          >
            <SelectTrigger
              size="sm"
              className="w-full min-w-0"
              aria-label={translate(
                'auto.components.NewWorkspaceComposerCard.launchProfileLabel',
                'Launch profile'
              )}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_LAUNCH_VALUE}>
                {translate(
                  'auto.components.NewWorkspaceComposerCard.launchProfileDefault',
                  'Default launch'
                )}
              </SelectItem>
              {quickLaunchProfiles.map((profile) => (
                <SelectItem key={profile.id} value={profile.id}>
                  {profile.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>

      <div className="!mb-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onToggleAdvanced}
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
