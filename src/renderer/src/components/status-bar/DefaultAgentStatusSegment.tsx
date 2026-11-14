import React, { useCallback, useEffect, useMemo } from 'react'
import { Check, Settings2, Sparkles, Terminal } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentIcon, getAgentCatalog, getAgentLabel } from '@/lib/agent-catalog'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'
import {
  listSelectableDefaultAgents,
  resolveDefaultAgentSelection,
  resolveDefaultAgentTriggerLabel,
  type DefaultAgentChoice
} from './default-agent-status-selection'

function DefaultAgentStatusSegmentInner({ iconOnly }: { iconOnly: boolean }): React.JSX.Element {
  const defaultAgent = useAppStore((s) => s.settings?.defaultTuiAgent)
  const disabledAgents = useAppStore((s) => s.settings?.disabledTuiAgents)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const detectedAgentIds = useAppStore((s) => s.detectedAgentIds)
  const ensureDetectedAgents = useAppStore((s) => s.ensureDetectedAgents)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)

  useEffect(() => {
    void ensureDetectedAgents()
  }, [ensureDetectedAgents])

  const detectedIds = useMemo(
    () => (detectedAgentIds === null ? null : new Set(detectedAgentIds)),
    [detectedAgentIds]
  )

  const selection = useMemo(
    () =>
      resolveDefaultAgentSelection({
        defaultAgent,
        detectedIds,
        disabledAgents
      }),
    [defaultAgent, detectedIds, disabledAgents]
  )

  const selectableAgents = useMemo(
    () =>
      listSelectableDefaultAgents({
        catalog: getAgentCatalog(),
        detectedIds,
        disabledAgents
      }),
    [detectedIds, disabledAgents]
  )

  const autoLabel = translate('auto.components.status.bar.DefaultAgentStatusSegment.auto', 'Auto')
  const blankLabel = translate(
    'auto.components.status.bar.DefaultAgentStatusSegment.blank',
    'Blank'
  )
  const agentLabel =
    selection.kind === 'agent' && selection.agentId ? getAgentLabel(selection.agentId) : null
  const triggerLabel = resolveDefaultAgentTriggerLabel({
    selection,
    agentLabel,
    autoLabel,
    blankLabel
  })

  const setDefault = useCallback(
    (next: DefaultAgentChoice) => {
      void updateSettings({ defaultTuiAgent: next })
    },
    [updateSettings]
  )

  const openAgentSettings = useCallback(() => {
    openSettingsTarget({ pane: 'agents', repoId: null })
    openSettingsPage()
  }, [openSettingsPage, openSettingsTarget])

  const triggerIcon =
    selection.kind === 'agent' && selection.agentId ? (
      <AgentIcon agent={selection.agentId} size={12} />
    ) : selection.kind === 'blank' ? (
      <Terminal className="size-3 text-muted-foreground" aria-hidden />
    ) : (
      <Sparkles className="size-3 text-muted-foreground" aria-hidden />
    )

  return (
    <DropdownMenu>
      <Tooltip delayDuration={150}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-accent/70"
              aria-label={translate(
                'auto.components.status.bar.DefaultAgentStatusSegment.ariaLabel',
                'Default agent: {{value0}}',
                { value0: triggerLabel }
              )}
            >
              {triggerIcon}
              {!iconOnly ? (
                <span className="max-w-[7rem] truncate text-[11px] font-medium text-muted-foreground">
                  {triggerLabel}
                </span>
              ) : null}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          {translate(
            'auto.components.status.bar.DefaultAgentStatusSegment.tooltip',
            'Default agent — {{value0}}',
            { value0: triggerLabel }
          )}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
        side="top"
        align="end"
        sideOffset={8}
        className="min-w-[220px]"
      >
        <DropdownMenuLabel>
          {translate('auto.components.status.bar.DefaultAgentStatusSegment.title', 'Default Agent')}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => setDefault(null)}>
          <span className="flex w-4 items-center justify-center">
            {selection.kind === 'auto' ? <Check className="size-3.5" aria-hidden /> : null}
          </span>
          <Sparkles className="size-3.5 text-muted-foreground" aria-hidden />
          <span className="flex-1">{autoLabel}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setDefault('blank')}>
          <span className="flex w-4 items-center justify-center">
            {selection.kind === 'blank' ? <Check className="size-3.5" aria-hidden /> : null}
          </span>
          <Terminal className="size-3.5 text-muted-foreground" aria-hidden />
          <span className="flex-1">
            {translate(
              'auto.components.status.bar.DefaultAgentStatusSegment.blankTerminal',
              'No agent (blank terminal)'
            )}
          </span>
        </DropdownMenuItem>
        {selectableAgents.length > 0 ? <DropdownMenuSeparator /> : null}
        {selectableAgents.map((agent) => {
          const isActive = selection.kind === 'agent' && selection.agentId === agent.id
          return (
            <DropdownMenuItem key={agent.id} onSelect={() => setDefault(agent.id)}>
              <span className="flex w-4 items-center justify-center">
                {isActive ? <Check className="size-3.5" aria-hidden /> : null}
              </span>
              <AgentIcon agent={agent.id} size={14} />
              <span className="flex-1 truncate">{agent.label}</span>
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={openAgentSettings}>
          <Settings2 className="size-3.5" aria-hidden />
          {translate(
            'auto.components.status.bar.DefaultAgentStatusSegment.settings',
            'Agent settings…'
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export const DefaultAgentStatusSegment = React.memo(DefaultAgentStatusSegmentInner)
