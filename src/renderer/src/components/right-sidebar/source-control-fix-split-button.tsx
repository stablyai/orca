import React, { useState } from 'react'
import { ChevronDown, RefreshCw, SlidersHorizontal, Sparkle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId
} from '../../../../shared/source-control-ai-actions'
import type { TuiAgent } from '../../../../shared/types'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import type { SourceControlAiWriteTarget } from '../../../../shared/source-control-ai-recipe-save'
import { translate } from '@/i18n/i18n'
import { SourceControlAgentActionDialog } from './SourceControlAgentActionDialog'

export type SourceControlFixSplitButtonProps = {
  label: string
  actionId: SourceControlLaunchActionId
  dialogTitle: string
  dialogDescription: string
  launchSource: LaunchSource
  contextUnavailableLabel: string
  primaryTitle: string
  primaryAriaLabel: string
  chevronTitle: string
  chevronAriaLabel: string
  worktreeId: string | null
  groupId: string | null
  connectionId?: string | null
  repoId?: string | null
  launchPlatform?: NodeJS.Platform
  prompt: string | null
  isLaunching: boolean
  disabledReason?: string
  variant: React.ComponentProps<typeof Button>['variant']
  size: React.ComponentProps<typeof Button>['size']
  iconClassName: string
  primaryClassName?: string
  chevronClassName?: string
  savedAgentId?: TuiAgent | null
  savedCommandInputTemplate?: string | null
  savedAgentArgs?: string | null
  onSaveAgentDefault?: (
    target: SourceControlAiWriteTarget,
    actionId: SourceControlLaunchActionId,
    recipe: SourceControlActionRecipe
  ) => void | Promise<void>
  onOpenSettings?: () => void
  onFixWithDefaultAgent: (promptOverride?: string) => Promise<boolean> | boolean
  onPromptDelivered?: () => void
}

export function SourceControlFixSplitButton({
  label,
  actionId,
  dialogTitle,
  dialogDescription,
  launchSource,
  contextUnavailableLabel,
  primaryTitle,
  primaryAriaLabel,
  chevronTitle,
  chevronAriaLabel,
  worktreeId,
  groupId,
  connectionId,
  repoId,
  launchPlatform,
  prompt,
  isLaunching,
  disabledReason,
  variant,
  size,
  iconClassName,
  primaryClassName,
  chevronClassName,
  savedAgentId,
  savedCommandInputTemplate,
  savedAgentArgs,
  onSaveAgentDefault,
  onOpenSettings,
  onFixWithDefaultAgent,
  onPromptDelivered
}: SourceControlFixSplitButtonProps): React.JSX.Element {
  const [composerOpen, setComposerOpen] = useState(false)
  const canLaunch = Boolean(worktreeId && groupId && prompt && !disabledReason)
  const dividerClass = variant === 'default' ? 'border-primary-foreground/20' : 'border-border'

  return (
    <>
      <DropdownMenu>
        <div className="flex shrink-0 items-stretch">
          <Button
            type="button"
            variant={variant}
            size={size}
            className={cn('rounded-r-none', primaryClassName)}
            disabled={isLaunching || !canLaunch}
            title={disabledReason ?? primaryTitle}
            aria-label={primaryAriaLabel}
            onClick={() => void onFixWithDefaultAgent()}
          >
            {isLaunching ? (
              <RefreshCw className={cn(iconClassName, 'animate-spin')} />
            ) : (
              <Sparkle className={iconClassName} />
            )}
            {label}
          </Button>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant={variant}
              size={size}
              className={cn('rounded-l-none border-l', dividerClass, chevronClassName)}
              disabled={isLaunching || !canLaunch}
              title={chevronTitle}
              aria-label={chevronAriaLabel}
            >
              <ChevronDown className={iconClassName} />
            </Button>
          </DropdownMenuTrigger>
        </div>
        <DropdownMenuContent align="end" className="min-w-[210px] p-1">
          {worktreeId && groupId && prompt && !disabledReason ? (
            <DropdownMenuItem
              onSelect={() => setComposerOpen(true)}
              className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
            >
              <SlidersHorizontal className="size-4 text-muted-foreground" />
              {translate(
                'auto.components.right.sidebar.SourceControl.f0a2dc9e46',
                'Customize launch...'
              )}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled>{contextUnavailableLabel}</DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {worktreeId && groupId && prompt ? (
        <SourceControlAgentActionDialog
          open={composerOpen}
          onOpenChange={setComposerOpen}
          actionId={actionId}
          title={dialogTitle}
          description={dialogDescription}
          baseCommandInput={prompt}
          worktreeId={worktreeId}
          groupId={groupId}
          connectionId={connectionId}
          repoId={repoId}
          promptDelivery="submit-after-ready"
          launchPlatform={launchPlatform}
          launchSource={launchSource}
          savedAgentId={savedAgentId}
          savedCommandInputTemplate={savedCommandInputTemplate}
          savedAgentArgs={savedAgentArgs}
          onSaveAgentDefault={onSaveAgentDefault}
          onOpenSettings={onOpenSettings}
          onLaunched={onPromptDelivered}
        />
      ) : null}
    </>
  )
}
