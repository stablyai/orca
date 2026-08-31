import React from 'react'
import { LoaderCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { GitHubMarkdownComposer } from '@/components/github/GitHubMarkdownComposer'
import IssueSourceSelector from '@/components/github/IssueSourceSelector'
import { sameGitHubOwnerRepo } from '@/components/github/IssueSourceIndicator'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import type { TaskPageRepoSourceState } from '@/components/task-page-cache-selectors'
import { resolveUserRepoSwitchReset } from '@/components/task-page-new-issue-draft'
import type { MetadataListState } from '@/hooks/useMetadataListRequest'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { translate } from '@/i18n/i18n'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type { IssueSourcePreference, Repo } from '../../../../../shared/repo-types'
import { GitHubIssueAssigneeSelector } from '../github/github-issue-assignee-selector'
import { GitHubIssueLabelSelector } from '../github/github-issue-label-selector'

export type NewGithubIssueDialogProps = {
  newIssueOpen: boolean
  newIssueSubmitting: boolean
  setNewIssueOpen: (open: boolean) => void
  handleCreateNewIssue: () => Promise<void> | void
  newIssueTargetRepo: Repo | null
  perRepoSourceState: TaskPageRepoSourceState[]
  setIssueSourcePreference: (
    repoId: string,
    repoPath: string,
    preference: IssueSourcePreference
  ) => Promise<void>
  selectedRepos: readonly Repo[]
  newIssueRepoId: string | null
  setNewIssueRepoId: (id: string | null) => void
  setNewIssueLabels: (labels: string[]) => void
  setNewIssueAssignees: (assignees: GitHubAssignableUser[]) => void
  newIssueTitle: string
  setNewIssueTitle: (value: string) => void
  newIssueBody: string
  setNewIssueBody: (value: string) => void
  newIssueRepoLabels: MetadataListState<string>
  newIssueLabels: string[]
  newIssueRepoAssignees: MetadataListState<GitHubAssignableUser>
  newIssueAssignees: GitHubAssignableUser[]
  submitShortcutLabel: string
}

export function NewGithubIssueDialog({
  newIssueOpen,
  newIssueSubmitting,
  setNewIssueOpen,
  handleCreateNewIssue,
  newIssueTargetRepo,
  perRepoSourceState,
  setIssueSourcePreference,
  selectedRepos,
  newIssueRepoId,
  setNewIssueRepoId,
  setNewIssueLabels,
  setNewIssueAssignees,
  newIssueTitle,
  setNewIssueTitle,
  newIssueBody,
  setNewIssueBody,
  newIssueRepoLabels,
  newIssueLabels,
  newIssueRepoAssignees,
  newIssueAssignees,
  submitShortcutLabel
}: NewGithubIssueDialogProps): React.JSX.Element {
  return (
    <Dialog
      open={newIssueOpen}
      onOpenChange={(open) => {
        if (!newIssueSubmitting) {
          setNewIssueOpen(open)
        }
      }}
    >
      <DialogContent
        className="sm:max-w-2xl"
        onKeyDown={(event) => {
          if (isScreenSubmitShortcut(event)) {
            event.preventDefault()
            void handleCreateNewIssue()
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
            const fallback =
              newIssueTargetRepo?.displayName ??
              translate(
                'auto.components.task.page.dialogs.new.github.issue.dialog.e02508846c',
                'this repository'
              )
            return (
              <DialogDescription>
                {translate('auto.components.TaskPage.9f2b4c03a6', 'Filing in')}{' '}
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
            <label className="text-[11px] font-medium text-muted-foreground">
              {translate('auto.components.TaskPage.16cba35bee', 'Title')}
            </label>
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
              disabled={newIssueSubmitting}
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
              disabled={newIssueSubmitting}
              minHeightClassName="min-h-40"
              onSubmitShortcut={() => void handleCreateNewIssue()}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <GitHubIssueLabelSelector
              labels={newIssueRepoLabels.data}
              selectedLabels={newIssueLabels}
              loading={newIssueRepoLabels.loading}
              error={newIssueRepoLabels.error}
              disabled={newIssueSubmitting || !newIssueTargetRepo}
              onChange={setNewIssueLabels}
            />
            <GitHubIssueAssigneeSelector
              assignees={newIssueRepoAssignees.data}
              selectedAssignees={newIssueAssignees}
              loading={newIssueRepoAssignees.loading}
              error={newIssueRepoAssignees.error}
              disabled={newIssueSubmitting || !newIssueTargetRepo}
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
            onClick={() => setNewIssueOpen(false)}
            disabled={newIssueSubmitting}
          >
            {translate('auto.components.TaskPage.ff69a30681', 'Cancel')}
          </Button>
          <Button
            onClick={() => void handleCreateNewIssue()}
            disabled={!newIssueTargetRepo || !newIssueTitle.trim() || newIssueSubmitting}
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
