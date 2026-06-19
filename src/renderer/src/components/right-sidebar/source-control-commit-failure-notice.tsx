import React from 'react'
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
import { CommitFailureFixSplitButton } from './source-control-commit-failure-action'
import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId
} from '../../../../shared/source-control-ai-actions'
import type { SourceControlAiWriteTarget } from '../../../../shared/source-control-ai-recipe-save'

export function CommitFailureNotice({
  worktreeId,
  groupId,
  connectionId,
  repoId,
  launchPlatform,
  commitError,
  commitFailureSummary,
  commitFailureKindLabel,
  hasCommitFailureDetails,
  commitFailureWorktreeKey,
  isCommitFailureDialogOpen,
  commitFailureRecoveryPrompt,
  isFixingCommitFailureWithAI,
  fixCommitFailureRecipe,
  onSaveLaunchActionDefault,
  onOpenSourceControlAiSettings,
  onFixCommitFailureWithAI,
  onPromptDelivered,
  onCommitFailureDialogOpenChange
}: {
  worktreeId: string | null
  groupId: string | null
  connectionId?: string | null
  repoId?: string | null
  launchPlatform?: NodeJS.Platform
  commitError: string | null
  commitFailureSummary: string | null
  commitFailureKindLabel: string | null
  hasCommitFailureDetails: boolean
  commitFailureWorktreeKey: string
  isCommitFailureDialogOpen: boolean
  commitFailureRecoveryPrompt: string | null
  isFixingCommitFailureWithAI: boolean
  fixCommitFailureRecipe?: SourceControlActionRecipe
  onSaveLaunchActionDefault?: (
    target: SourceControlAiWriteTarget,
    actionId: SourceControlLaunchActionId,
    recipe: SourceControlActionRecipe
  ) => void | Promise<void>
  onOpenSourceControlAiSettings?: () => void
  onFixCommitFailureWithAI: (promptOverride?: string) => Promise<boolean> | boolean
  onPromptDelivered: () => void
  onCommitFailureDialogOpenChange: (open: boolean) => void
}): React.JSX.Element | null {
  if (!commitError) {
    return null
  }

  return (
    <>
      {/* Why: role="alert" + aria-live="polite" lets screen readers announce
          commit failures; the id ties the message to the textarea via
          aria-describedby so assistive tech associates the two. */}
      <div
        id="commit-area-error"
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
              <span className="text-xs font-semibold text-foreground">
                {translate(
                  'auto.components.right.sidebar.SourceControl.011f9713fc',
                  'Commit blocked'
                )}
              </span>
              {commitFailureKindLabel ? (
                <span className="shrink-0 rounded-full bg-destructive/10 px-1.5 py-px text-[10px] leading-4 font-semibold text-destructive">
                  {commitFailureKindLabel}
                </span>
              ) : null}
            </div>
            <p className="col-start-2 mt-0.5 line-clamp-3 min-w-0 font-mono text-[11px] leading-4 break-words text-muted-foreground [overflow-wrap:anywhere]">
              {commitFailureSummary}
            </p>
          </div>
          <div className="ml-[1.375rem] flex min-w-0 items-center gap-1.5">
            <CommitFailureFixSplitButton
              label={translate('auto.components.right.sidebar.SourceControl.60bd988f0b', 'AI Fix')}
              worktreeId={worktreeId}
              groupId={groupId}
              connectionId={connectionId}
              repoId={repoId}
              launchPlatform={launchPlatform}
              prompt={commitFailureRecoveryPrompt}
              isLaunching={isFixingCommitFailureWithAI}
              variant="secondary"
              size="xs"
              iconClassName="size-3"
              primaryClassName="h-6 px-2 text-[11px]"
              chevronClassName="h-6 px-1.5"
              savedAgentId={readSourceControlLaunchRecipeAgentId(fixCommitFailureRecipe)}
              savedCommandInputTemplate={fixCommitFailureRecipe?.commandInputTemplate ?? null}
              savedAgentArgs={fixCommitFailureRecipe?.agentArgs ?? null}
              onSaveAgentDefault={onSaveLaunchActionDefault}
              onOpenSettings={onOpenSourceControlAiSettings}
              onFixWithDefaultAgent={onFixCommitFailureWithAI}
              onPromptDelivered={onPromptDelivered}
            />
            {hasCommitFailureDetails && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="h-6 shrink-0 border-foreground/25 px-2 text-[11px] font-semibold"
                onClick={() => onCommitFailureDialogOpenChange(true)}
              >
                {translate('auto.components.right.sidebar.SourceControl.03d238218c', 'Details')}
              </Button>
            )}
          </div>
        </div>
      </div>
      {commitFailureSummary && hasCommitFailureDetails && (
        <Dialog
          key={commitFailureWorktreeKey}
          open={isCommitFailureDialogOpen}
          onOpenChange={onCommitFailureDialogOpenChange}
        >
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>
                {translate(
                  'auto.components.right.sidebar.SourceControl.a9bf7c171a',
                  'Commit Failed'
                )}
              </DialogTitle>
              <DialogDescription>{commitFailureSummary}</DialogDescription>
            </DialogHeader>
            <pre className="max-h-[60vh] overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap text-foreground scrollbar-sleek">
              {commitError}
            </pre>
            <DialogFooter>
              <CommitFailureFixSplitButton
                label={translate(
                  'auto.components.right.sidebar.SourceControl.834cb3f23d',
                  'Fix with AI'
                )}
                worktreeId={worktreeId}
                groupId={groupId}
                connectionId={connectionId}
                repoId={repoId}
                launchPlatform={launchPlatform}
                prompt={commitFailureRecoveryPrompt}
                isLaunching={isFixingCommitFailureWithAI}
                variant="default"
                size="sm"
                iconClassName="size-4"
                primaryClassName="rounded-r-none"
                chevronClassName="rounded-l-none border-l border-primary-foreground/20 px-2"
                savedAgentId={readSourceControlLaunchRecipeAgentId(fixCommitFailureRecipe)}
                savedCommandInputTemplate={fixCommitFailureRecipe?.commandInputTemplate ?? null}
                savedAgentArgs={fixCommitFailureRecipe?.agentArgs ?? null}
                onSaveAgentDefault={onSaveLaunchActionDefault}
                onOpenSettings={onOpenSourceControlAiSettings}
                onFixWithDefaultAgent={onFixCommitFailureWithAI}
                onPromptDelivered={onPromptDelivered}
              />
              <DialogClose asChild>
                <Button type="button" variant="outline" size="sm">
                  {translate('auto.components.right.sidebar.SourceControl.783a808870', 'Close')}
                </Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
