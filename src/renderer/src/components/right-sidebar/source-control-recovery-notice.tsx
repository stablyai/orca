import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { readSourceControlLaunchRecipeAgentId } from '@/lib/source-control-launch-agent-selection'
import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId
} from '../../../../shared/source-control-ai-actions'
import type { SourceControlAiWriteTarget } from '../../../../shared/source-control-ai-recipe-save'
import { SourceControlFixSplitButton } from './source-control-fix-split-button'

export type SourceControlRecoveryKind = 'commit' | 'push'

type SourceControlRecoveryNoticeProps = {
  id: string
  recoveryKind: SourceControlRecoveryKind
  title: string
  detailsTitle: string
  summary: string
  detailText: string
  hasDetails: boolean
  kindLabel: string | null
  prompt: string | null
  worktreeId: string | null
  groupId: string | null
  connectionId?: string | null
  repoId?: string | null
  launchPlatform?: NodeJS.Platform
  sourceControlAiActionsVisible: boolean
  isLaunching: boolean
  recipe?: SourceControlActionRecipe
  onSaveLaunchActionDefault?: (
    target: SourceControlAiWriteTarget,
    actionId: SourceControlLaunchActionId,
    recipe: SourceControlActionRecipe
  ) => void | Promise<void>
  onOpenSourceControlAiSettings?: () => void
  onFixWithAI: (promptOverride?: string) => Promise<boolean> | boolean
}

type RecoveryDialogState = {
  worktreeKey: string
  open: boolean
}

function getRecoveryDialogKey(
  recoveryKind: SourceControlRecoveryKind,
  worktreeId: string | null | undefined
): string {
  return `${recoveryKind}:${worktreeId ?? 'no-worktree'}`
}

function syncRecoveryDialogState(
  state: RecoveryDialogState,
  worktreeKey: string,
  hasDetails: boolean
): RecoveryDialogState {
  if (state.worktreeKey === worktreeKey && hasDetails) {
    return state
  }
  return { worktreeKey, open: false }
}

function shouldShowRecoveryDialog(
  state: RecoveryDialogState,
  worktreeKey: string,
  hasDetails: boolean
): boolean {
  return hasDetails && state.open && state.worktreeKey === worktreeKey
}

function getRecoveryActionId(recoveryKind: SourceControlRecoveryKind): SourceControlLaunchActionId {
  return recoveryKind === 'push' ? 'fixPushFailure' : 'fixCommitFailure'
}

function useRecoveryCopy(recoveryKind: SourceControlRecoveryKind): {
  inlineFixLabel: string
  dialogFixLabel: string
  defaultAgentTitle: string
  fixAriaLabel: string
  chooseAgentTitle: string
  chooseAgentAriaLabel: string
  contextUnavailable: string
  launchDialogTitle: string
  dialogDescription: string
} {
  return useMemo(() => {
    if (recoveryKind === 'push') {
      return {
        inlineFixLabel: translate(
          'auto.components.right.sidebar.SourceControl.pushRecovery.60bd988f0b',
          'AI Fix'
        ),
        dialogFixLabel: translate(
          'auto.components.right.sidebar.SourceControl.pushRecovery.834cb3f23d',
          'Fix with AI'
        ),
        defaultAgentTitle: translate(
          'auto.components.right.sidebar.SourceControl.pushRecovery.4b37ae99b0',
          'Start the default AI agent to fix this push failure'
        ),
        fixAriaLabel: translate(
          'auto.components.right.sidebar.SourceControl.pushRecovery.30b8d4f181',
          'Fix push failure with AI'
        ),
        chooseAgentTitle: translate(
          'auto.components.right.sidebar.SourceControl.pushRecovery.dd43c47089',
          'Choose an agent for this push failure'
        ),
        chooseAgentAriaLabel: translate(
          'auto.components.right.sidebar.SourceControl.pushRecovery.ec7bfced55',
          'Choose agent to fix push failure'
        ),
        contextUnavailable: translate(
          'auto.components.right.sidebar.SourceControl.pushRecovery.9e5ccd00aa',
          'Push failure context unavailable'
        ),
        launchDialogTitle: translate(
          'auto.components.right.sidebar.SourceControl.pushRecovery.054ead86b1',
          'Fix Push Failure With AI'
        ),
        dialogDescription: translate(
          'auto.components.right.sidebar.SourceControl.pushRecovery.15b7f210d7',
          'Choose the agent and edit the full command input before launch.'
        )
      }
    }

    return {
      inlineFixLabel: translate('auto.components.right.sidebar.SourceControl.60bd988f0b', 'AI Fix'),
      dialogFixLabel: translate(
        'auto.components.right.sidebar.SourceControl.834cb3f23d',
        'Fix with AI'
      ),
      defaultAgentTitle: translate(
        'auto.components.right.sidebar.SourceControl.4b37ae99b0',
        'Start the default AI agent to fix this commit failure'
      ),
      fixAriaLabel: translate(
        'auto.components.right.sidebar.SourceControl.30b8d4f181',
        'Fix commit failure with AI'
      ),
      chooseAgentTitle: translate(
        'auto.components.right.sidebar.SourceControl.dd43c47089',
        'Choose an agent for this commit failure'
      ),
      chooseAgentAriaLabel: translate(
        'auto.components.right.sidebar.SourceControl.ec7bfced55',
        'Choose agent to fix commit failure'
      ),
      contextUnavailable: translate(
        'auto.components.right.sidebar.SourceControl.9e5ccd00aa',
        'Commit failure context unavailable'
      ),
      launchDialogTitle: translate(
        'auto.components.right.sidebar.SourceControl.054ead86b1',
        'Fix Commit Failure With AI'
      ),
      dialogDescription: translate(
        'auto.components.right.sidebar.SourceControl.15b7f210d7',
        'Choose the agent and edit the full command input before launch.'
      )
    }
  }, [recoveryKind])
}

export function SourceControlRecoveryNotice({
  id,
  recoveryKind,
  title,
  detailsTitle,
  summary,
  detailText,
  hasDetails,
  kindLabel,
  prompt,
  worktreeId,
  groupId,
  connectionId,
  repoId,
  launchPlatform,
  sourceControlAiActionsVisible,
  isLaunching,
  recipe,
  onSaveLaunchActionDefault,
  onOpenSourceControlAiSettings,
  onFixWithAI
}: SourceControlRecoveryNoticeProps): React.JSX.Element {
  const worktreeKey = getRecoveryDialogKey(recoveryKind, worktreeId)
  const [dialogState, setDialogState] = useState<RecoveryDialogState>({
    worktreeKey,
    open: false
  })
  const dialogOpen = shouldShowRecoveryDialog(dialogState, worktreeKey, hasDetails)
  const setDialogOpen = useCallback(
    (open: boolean) => {
      setDialogState({ worktreeKey, open })
    },
    [worktreeKey]
  )
  const copy = useRecoveryCopy(recoveryKind)
  const actionId = getRecoveryActionId(recoveryKind)
  const handleFixWithAI = useCallback(
    async (promptOverride?: string): Promise<boolean> => {
      const launched = await onFixWithAI(promptOverride)
      if (launched) {
        setDialogOpen(false)
      }
      return launched
    },
    [onFixWithAI, setDialogOpen]
  )
  const handlePromptDelivered = useCallback(() => {
    setDialogOpen(false)
  }, [setDialogOpen])

  useEffect(() => {
    setDialogState((current) => syncRecoveryDialogState(current, worktreeKey, hasDetails))
  }, [hasDetails, worktreeKey])

  const splitButtonProps = {
    actionId,
    dialogTitle: copy.launchDialogTitle,
    dialogDescription: copy.dialogDescription,
    launchSource: 'source_control_recovery' as const,
    contextUnavailableLabel: copy.contextUnavailable,
    primaryTitle: copy.defaultAgentTitle,
    primaryAriaLabel: copy.fixAriaLabel,
    chevronTitle: copy.chooseAgentTitle,
    chevronAriaLabel: copy.chooseAgentAriaLabel,
    worktreeId,
    groupId,
    connectionId,
    repoId,
    launchPlatform,
    prompt,
    isLaunching,
    savedAgentId: readSourceControlLaunchRecipeAgentId(recipe),
    savedCommandInputTemplate: recipe?.commandInputTemplate ?? null,
    savedAgentArgs: recipe?.agentArgs ?? null,
    onSaveAgentDefault: onSaveLaunchActionDefault,
    onOpenSettings: onOpenSourceControlAiSettings,
    onFixWithDefaultAgent: handleFixWithAI,
    onPromptDelivered: handlePromptDelivered
  }

  return (
    <>
      <div
        id={id}
        role="alert"
        aria-live="polite"
        className="mt-2 min-w-0 overflow-hidden rounded-lg border border-destructive/20 bg-card text-card-foreground shadow-xs"
      >
        <div className="h-0.5 bg-destructive/70" aria-hidden="true" />
        <div className="grid min-w-0 gap-2 px-2.5 py-2.5">
          <div className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-1.5">
            <span className="mt-px inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <TriangleAlert className="size-3" aria-hidden="true" />
            </span>
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="text-xs font-semibold text-foreground">{title}</span>
              {kindLabel ? (
                <span className="shrink-0 rounded-full bg-destructive/10 px-1.5 py-px text-[10px] leading-4 font-semibold text-destructive">
                  {kindLabel}
                </span>
              ) : null}
            </div>
            <p className="col-start-2 mt-0.5 line-clamp-3 min-w-0 font-mono text-[11px] leading-4 break-words text-muted-foreground [overflow-wrap:anywhere]">
              {summary}
            </p>
          </div>
          <div className="ml-[1.375rem] flex min-w-0 items-center gap-1.5">
            {sourceControlAiActionsVisible ? (
              <SourceControlFixSplitButton
                {...splitButtonProps}
                label={copy.inlineFixLabel}
                variant="secondary"
                size="xs"
                iconClassName="size-3"
                primaryClassName="h-6 px-2 text-[11px]"
                chevronClassName="h-6 px-1.5"
              />
            ) : null}
            {hasDetails ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="h-6 shrink-0 border-foreground/25 px-2 text-[11px] font-semibold"
                onClick={() => setDialogOpen(true)}
              >
                {translate(
                  'auto.components.right.sidebar.SourceControl.pushRecovery.03d238218c',
                  'Details'
                )}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      {hasDetails ? (
        <Dialog key={worktreeKey} open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{detailsTitle}</DialogTitle>
              <DialogDescription>{summary}</DialogDescription>
            </DialogHeader>
            <pre className="max-h-[60vh] overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap text-foreground scrollbar-sleek">
              {detailText}
            </pre>
            <DialogFooter>
              {sourceControlAiActionsVisible ? (
                <SourceControlFixSplitButton
                  {...splitButtonProps}
                  label={copy.dialogFixLabel}
                  variant="default"
                  size="sm"
                  iconClassName="size-4"
                  primaryClassName="rounded-r-none"
                  chevronClassName="rounded-l-none border-l border-primary-foreground/20 px-2"
                />
              ) : null}
              <DialogClose asChild>
                <Button type="button" variant="outline" size="sm">
                  {translate(
                    'auto.components.right.sidebar.SourceControl.pushRecovery.783a808870',
                    'Close'
                  )}
                </Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  )
}
