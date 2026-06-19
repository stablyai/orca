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
import { translate } from '@/i18n/i18n'
import { SourceControlAgentActionDialog } from './SourceControlAgentActionDialog'
import type { TuiAgent } from '../../../../shared/types'
import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId
} from '../../../../shared/source-control-ai-actions'
import type { SourceControlAiWriteTarget } from '../../../../shared/source-control-ai-recipe-save'

export type CommitFailureFixSplitButtonProps = {
  label: string
  worktreeId: string | null
  groupId: string | null
  connectionId?: string | null
  repoId?: string | null
  launchPlatform?: NodeJS.Platform
  prompt: string | null
  isLaunching: boolean
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
  onPromptDelivered: () => void
}

export function CommitFailureFixSplitButton({
  label,
  worktreeId,
  groupId,
  connectionId,
  repoId,
  launchPlatform,
  prompt,
  isLaunching,
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
}: CommitFailureFixSplitButtonProps): React.JSX.Element {
  const [composerOpen, setComposerOpen] = useState(false)
  const canLaunch = Boolean(worktreeId && groupId && prompt)
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
            onClick={() => void onFixWithDefaultAgent()}
            title={translate(
              'auto.components.right.sidebar.SourceControl.4b37ae99b0',
              'Start the default AI agent to fix this commit failure'
            )}
            aria-label={translate(
              'auto.components.right.sidebar.SourceControl.30b8d4f181',
              'Fix commit failure with AI'
            )}
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
              title={translate(
                'auto.components.right.sidebar.SourceControl.dd43c47089',
                'Choose an agent for this commit failure'
              )}
              aria-label={translate(
                'auto.components.right.sidebar.SourceControl.ec7bfced55',
                'Choose agent to fix commit failure'
              )}
            >
              <ChevronDown className={iconClassName} />
            </Button>
          </DropdownMenuTrigger>
        </div>
        <DropdownMenuContent align="end" className="min-w-[210px] p-1">
          {worktreeId && groupId && prompt ? (
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
            <DropdownMenuItem disabled>
              {translate(
                'auto.components.right.sidebar.SourceControl.9e5ccd00aa',
                'Commit failure context unavailable'
              )}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {worktreeId && groupId && prompt ? (
        <SourceControlAgentActionDialog
          open={composerOpen}
          onOpenChange={setComposerOpen}
          actionId="fixCommitFailure"
          title={translate(
            'auto.components.right.sidebar.SourceControl.054ead86b1',
            'Fix Commit Failure With AI'
          )}
          description={translate(
            'auto.components.right.sidebar.SourceControl.15b7f210d7',
            'Choose the agent and edit the full command input before launch.'
          )}
          baseCommandInput={prompt}
          worktreeId={worktreeId}
          groupId={groupId}
          connectionId={connectionId}
          repoId={repoId}
          promptDelivery="submit-after-ready"
          launchPlatform={launchPlatform}
          launchSource="source_control_recovery"
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

export function getCommitFailureKindLabel(summary: string): string | null {
  if (/\blint\b/i.test(summary)) {
    return 'Lint'
  }

  if (/\bhook\b|\bpre-commit\b/i.test(summary)) {
    return 'Hook'
  }

  return null
}
