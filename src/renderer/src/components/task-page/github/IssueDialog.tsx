import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { translate } from '@/i18n/i18n'
import { sameGitHubOwnerRepo } from '@/components/github/IssueSourceIndicator'
import IssueSourceSelector from '@/components/github/IssueSourceSelector'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select'
import { resolveUserRepoSwitchReset } from '@/components/task-page-new-issue-draft'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { Input } from '@/components/ui/input'
import { GitHubMarkdownComposer } from '@/components/github/GitHubMarkdownComposer'
import { GitHubIssueLabelSelector, GitHubIssueAssigneeSelector } from './IssueSelectors'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LoaderCircle, RefreshCw, Sparkles, Square } from 'lucide-react'
export function TaskPageGitHubIssueDialog({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    setIssueSourcePreference,
    submitShortcutLabel,
    selectedRepos,
    perRepoSourceState,
    newIssueOpen,
    setNewIssueOpen,
    newIssueTitle,
    setNewIssueTitle,
    newIssueBody,
    setNewIssueBody,
    newIssueLabels,
    setNewIssueLabels,
    newIssueAssignees,
    setNewIssueAssignees,
    newIssueSubmitting,
    newIssueRepoId,
    setNewIssueRepoId,
    newIssueTargetRepo,
    newIssueRepoLabels,
    newIssueRepoAssignees,
    handleCreateNewIssue,
    newIssueAiEnabled,
    newIssueGenerating,
    newIssueGenerateError,
    newIssueGenerateDisabledReason,
    handleGenerateNewIssue,
    handleCancelGenerateNewIssue
  } = model
  // Why: generated fields only apply safely when the user can't race the request; lock title/body like the PR composer does.
  const newIssueFieldsLocked = newIssueSubmitting || newIssueGenerating
  const generateDisabled = !newIssueGenerating && Boolean(newIssueGenerateDisabledReason)
  const generateLabel = translate(
    'auto.components.task.page.github.IssueDialog.8e8eaf6e69',
    'Generate issue details with AI'
  )
  const stopGeneratingLabel = translate(
    'auto.components.task.page.github.IssueDialog.985c23e752',
    'Stop generating issue details'
  )
  const generateTooltipLabel = newIssueGenerating
    ? stopGeneratingLabel
    : (newIssueGenerateDisabledReason ?? generateLabel)
  const generateButton = newIssueGenerating ? (
    <Button
      type="button"
      variant="outline"
      size="xs"
      onClick={() => handleCancelGenerateNewIssue()}
      className="text-[11px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
      aria-label={stopGeneratingLabel}
    >
      <RefreshCw className="size-3 animate-spin" />
      <span>
        {translate('auto.components.task.page.github.IssueDialog.0e2eee0769', 'Generating…')}
      </span>
      <Square className="size-2.5 fill-current" />
    </Button>
  ) : (
    <Button
      type="button"
      variant="outline"
      size="xs"
      disabled={generateDisabled}
      onClick={() => void handleGenerateNewIssue()}
      className="text-[11px] disabled:hover:bg-background"
      aria-label={generateLabel}
    >
      <Sparkles className="size-3" />
      {translate('auto.components.task.page.github.IssueDialog.318d801f0b', 'Generate')}
    </Button>
  )
  return (
    <Dialog
      open={newIssueOpen}
      onOpenChange={(open) => {
        if (!newIssueSubmitting) {
          if (!open) {
            handleCancelGenerateNewIssue()
          }
          setNewIssueOpen(open)
        }
      }}
    >
      <DialogContent
        className="sm:max-w-2xl"
        onKeyDown={(event) => {
          if (isScreenSubmitShortcut(event)) {
            event.preventDefault()
            if (!newIssueGenerating) {
              void handleCreateNewIssue()
            }
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.TaskPage.d3d0998b7d', 'New GitHub issue')}
          </DialogTitle>
          {(() => {
            // Why: inline the resolved {owner}/{repo} slug as the source indicator; fall back to displayName when unresolved.
            const entry = newIssueTargetRepo
              ? perRepoSourceState.find((s) => s.repoId === newIssueTargetRepo.id)
              : undefined
            const issuesSlug = entry?.sources?.issues
              ? `${entry.sources.issues.owner}/${entry.sources.issues.repo}`
              : null
            const fallback = newIssueTargetRepo?.displayName ?? 'this repository'
            return (
              <DialogDescription>
                {translate('auto.components.TaskPage.9f2b4c03a6', 'Filing in')}
                {issuesSlug ?? fallback}
              </DialogDescription>
            )
          })()}
          {(() => {
            // Why: mirror the Tasks-view target selector so a fork contributor can flip target at filing time (fork-routing regression #1076).
            // Sibling (not nested) because DialogDescription renders a <p> and the selector a <div> — nesting is invalid HTML.
            if (!newIssueTargetRepo) {
              return null
            }
            const entry = perRepoSourceState.find((s) => s.repoId === newIssueTargetRepo.id)
            if (!entry || !entry.sources?.upstreamCandidate || !entry.sources?.originCandidate) {
              return null
            }
            if (
              sameGitHubOwnerRepo(entry.sources.originCandidate, entry.sources.upstreamCandidate)
            ) {
              return null
            }
            return (
              <div className="mt-1">
                <IssueSourceSelector
                  preference={newIssueTargetRepo.issueSourcePreference}
                  origin={entry.sources.originCandidate}
                  upstream={entry.sources.upstreamCandidate}
                  disabled={newIssueSubmitting}
                  // Why: composer only files issues, so the source tooltip is redundant here (kept on the Tasks header, which also lists PRs).
                  suppressTooltip
                  onChange={(next) => {
                    void setIssueSourcePreference(
                      newIssueTargetRepo.id,
                      newIssueTargetRepo.path,
                      next
                    )
                  }}
                />
              </div>
            )
          })()}
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {selectedRepos.length > 1 ? (
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-muted-foreground">
                {translate('auto.components.TaskPage.00022ec0ba', 'Project')}
              </label>
              <Select
                value={newIssueRepoId ?? undefined}
                onValueChange={(v) => {
                  // Why: repo-scoped labels/assignees can't survive a real repo switch, so clear them here (restore never routes through this handler).
                  setNewIssueRepoId(v)
                  const reset = resolveUserRepoSwitchReset()
                  setNewIssueLabels(reset.labels)
                  setNewIssueAssignees(reset.assignees)
                }}
                disabled={newIssueSubmitting}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {selectedRepos.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      <RepoBadgeLabel name={r.displayName} color={r.badgeColor} />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <label className="text-[11px] font-medium text-muted-foreground">
                {translate('auto.components.TaskPage.16cba35bee', 'Title')}
              </label>
              {newIssueAiEnabled ? (
                <Tooltip>
                  {!newIssueGenerating && generateDisabled ? (
                    <TooltipTrigger asChild>
                      <span className="inline-flex shrink-0 cursor-not-allowed">
                        {generateButton}
                      </span>
                    </TooltipTrigger>
                  ) : (
                    <TooltipTrigger asChild>{generateButton}</TooltipTrigger>
                  )}
                  <TooltipContent side="left" sideOffset={6}>
                    {generateTooltipLabel}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
            <Input
              autoFocus
              value={newIssueTitle}
              onChange={(e) => setNewIssueTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void handleCreateNewIssue()
                }
              }}
              placeholder={translate('auto.components.TaskPage.578f730c16', 'Short summary')}
              disabled={newIssueFieldsLocked}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              {translate('auto.components.TaskPage.7f3f7b4c18', 'Description (optional, markdown)')}
            </label>
            <GitHubMarkdownComposer
              value={newIssueBody}
              onChange={setNewIssueBody}
              placeholder={translate('auto.components.TaskPage.34d97ca682', "What's going on?")}
              disabled={newIssueFieldsLocked}
              minHeightClassName="min-h-40"
              onSubmitShortcut={() => void handleCreateNewIssue()}
            />
            {newIssueGenerateError ? (
              <p className="text-xs text-destructive">{newIssueGenerateError}</p>
            ) : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <GitHubIssueLabelSelector
              labels={newIssueRepoLabels.data}
              selectedLabels={newIssueLabels}
              loading={newIssueRepoLabels.loading}
              error={newIssueRepoLabels.error}
              disabled={newIssueFieldsLocked || !newIssueTargetRepo}
              onChange={setNewIssueLabels}
            />
            <GitHubIssueAssigneeSelector
              assignees={newIssueRepoAssignees.data}
              selectedAssignees={newIssueAssignees}
              loading={newIssueRepoAssignees.loading}
              error={newIssueRepoAssignees.error}
              disabled={newIssueFieldsLocked || !newIssueTargetRepo}
              onChange={setNewIssueAssignees}
            />
          </div>
          <p className="text-[10px] text-muted-foreground">
            {submitShortcutLabel} {translate('auto.components.TaskPage.fc0d8a1fa4', 'to submit.')}
          </p>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              handleCancelGenerateNewIssue()
              setNewIssueOpen(false)
            }}
            disabled={newIssueSubmitting}
          >
            {translate('auto.components.TaskPage.ff69a30681', 'Cancel')}
          </Button>
          <Button
            onClick={() => void handleCreateNewIssue()}
            disabled={!newIssueTargetRepo || !newIssueTitle.trim() || newIssueFieldsLocked}
          >
            {newIssueSubmitting ? (
              <>
                <LoaderCircle className="size-4 animate-spin" />
                {translate('auto.components.TaskPage.8ff6fdc368', 'Creating…')}
              </>
            ) : (
              translate('auto.components.TaskPage.e15ba2d2eb', 'Create issue')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
