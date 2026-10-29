import React, { useCallback } from 'react'
import { BarChart3, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentIcon } from '@/lib/agent-catalog'
import { useAppStore } from '../../store'
import { ClaudeIcon, GeminiIcon, OpenAIIcon, OpenCodeGoIcon } from './icons'
import { translate } from '@/i18n/i18n'
import { getUsageOwnerHostScope, type RemoteUsageOwner } from './use-owner-usage-rate-limits'

// Name the empty usage surface and route setup to its owning host; client-local setup cannot fill a remote bar.
export function StatusBarUsageEmptyCta({
  remoteOwner
}: {
  remoteOwner: RemoteUsageOwner | null
}): React.JSX.Element {
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const dismissUsageEmptyState = useAppStore((s) => s.dismissUsageEmptyState)

  // Open all providers because a new user has no provider selection yet.
  const handleOpenSettings = useCallback(() => {
    recordFeatureInteraction('usage-tracking')
    openSettingsTarget({
      pane: 'accounts',
      repoId: null,
      hostScope: getUsageOwnerHostScope(remoteOwner)
    })
    openSettingsPage()
  }, [openSettingsPage, openSettingsTarget, recordFeatureInteraction, remoteOwner])

  const label = remoteOwner
    ? translate(
        'auto.components.status.bar.StatusBarUsageEmptyCta.remoteLabel',
        'No usage on {{host}}',
        { host: remoteOwner.label }
      )
    : translate(
        'auto.components.status.bar.StatusBarUsageEmptyCta.d663430cf9',
        'Configure usage tracking'
      )

  const handleHide = useCallback(() => {
    dismissUsageEmptyState()
  }, [dismissUsageEmptyState])

  return (
    <HoverCard openDelay={150} closeDelay={80}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          onClick={handleOpenSettings}
          aria-label={label}
          className="inline-flex h-5 cursor-pointer items-center gap-1.5 rounded px-1.5 text-xs font-normal text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
        >
          <BarChart3 className="size-3.5" />
          <span>{label}</span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="start" sideOffset={8} className="w-[260px] p-2.5">
        <div className="space-y-2 text-xs leading-[1.45]">
          <div className="flex items-start justify-between gap-2">
            <div className="font-semibold text-foreground">
              {remoteOwner
                ? translate(
                    'auto.components.status.bar.StatusBarUsageEmptyCta.remoteTitle',
                    'Usage on {{host}}',
                    { host: remoteOwner.label }
                  )
                : translate(
                    'auto.components.status.bar.StatusBarUsageEmptyCta.84c3b15dca',
                    'Agent usage limits'
                  )}
            </div>
            {/* Mirror the setup-guide dismiss control so hiding this teaching CTA stays recognizable. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleHide}
                  aria-label={translate(
                    'auto.components.status.bar.StatusBarUsageEmptyCta.9a542f46c7',
                    'Hide from status bar'
                  )}
                  className="-mr-1 -mt-0.5 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
                >
                  <EyeOff className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                {translate(
                  'auto.components.status.bar.StatusBarUsageEmptyCta.9a542f46c7',
                  'Hide from status bar'
                )}
              </TooltipContent>
            </Tooltip>
          </div>
          {remoteOwner ? (
            <p className="text-muted-foreground">
              {translate(
                'auto.components.status.bar.StatusBarUsageEmptyCta.remoteBody',
                "This workspace runs on {{host}}, so the bar shows that host's usage. Sign in to an agent there, or focus a local workspace to see this computer's usage.",
                { host: remoteOwner.label }
              )}
            </p>
          ) : (
            <>
              <p className="text-muted-foreground">
                {translate(
                  'auto.components.status.bar.StatusBarUsageEmptyCta.97957ad3a3',
                  'Connect your AI provider accounts to see their usage in real time and easily switch between accounts.'
                )}
              </p>
              {/* Name the provider set so setup does not imply support for only one agent. */}
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <span>
                  {translate(
                    'auto.components.status.bar.StatusBarUsageEmptyCta.caa0f39811',
                    'Supports:'
                  )}
                </span>
                <ClaudeIcon size={13} />
                <OpenAIIcon size={13} />
                <GeminiIcon size={13} />
                <OpenCodeGoIcon size={13} />
                <AgentIcon agent="kimi" size={13} />
              </div>
            </>
          )}
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={handleOpenSettings}
            className="mt-0.5 h-7 w-full text-xs"
          >
            {remoteOwner
              ? translate(
                  'auto.components.status.bar.StatusBarUsageEmptyCta.remoteOpenAccounts',
                  'Open {{host}} accounts',
                  { host: remoteOwner.label }
                )
              : translate(
                  'auto.components.status.bar.StatusBarUsageEmptyCta.828c764a79',
                  'Connect an account'
                )}
          </Button>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}
