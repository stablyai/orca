import {
  Bot,
  ExternalLink,
  FileWarning,
  GitBranch,
  GitPullRequest,
  Terminal,
  Trash2
} from 'lucide-react'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-disk-space/workspace-space-types'
import { cn } from '@/lib/class-names'
import { Button } from '../ui/button'
import { HoverCardContent } from '../ui/hover-card'
import { formatBytes, getWorkspaceSpaceBranchLabel } from './workspace-space-format'
import { useTranslate } from '@/i18n/use-translate'
import type { WorkspaceDecisionDetails } from './workspace-space-decision-details'
import type { WorkspaceGitRefreshState } from './workspace-space-manager-state-types'
import { WorkspaceSpaceStatusBadge } from './workspace-space-status-badge'
import { WorkspaceSpaceIssueFreshness } from './workspace-space-issue-freshness'
import {
  getAgentDecisionLabel,
  getDeleteDecisionLabel,
  getEditorDecisionLabel,
  getGitDecisionLabel,
  getTerminalDecisionLabel
} from './workspace-space-decision-labels'

function DecisionLine({
  icon,
  label,
  value,
  tone = 'default'
}: {
  icon: React.ReactNode
  label: string
  value: string
  tone?: 'default' | 'warning'
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span
        className={cn(
          'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/30 text-muted-foreground [&>svg]:size-3',
          tone === 'warning' && 'border-destructive/25 bg-destructive/8 text-destructive'
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium uppercase tracking-[0.05em] text-muted-foreground">
          {label}
        </div>
        <div className="mt-0.5 truncate text-xs" title={value}>
          {value}
        </div>
      </div>
    </div>
  )
}

export function WorkspaceDecisionHoverCard({
  worktree,
  details,
  gitRefreshState,
  onOpenWorkspace
}: {
  worktree: WorkspaceSpaceWorktree
  details: WorkspaceDecisionDetails
  gitRefreshState?: WorkspaceGitRefreshState
  onOpenWorkspace: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const deleteDecision = getDeleteDecisionLabel(worktree, details, t)
  const issueLabel =
    [details.issueLabel, details.linearIssueLabel].filter(Boolean).join(' · ') ||
    t('auto.components.status.bar.workspaceSpaceDecision.noLinkedIssue', 'No linked issue')
  return (
    <HoverCardContent
      align="end"
      side="bottom"
      sideOffset={8}
      collisionPadding={12}
      className="max-h-[min(34rem,calc(100vh-1.5rem))] w-[min(24rem,calc(100vw-1.5rem))] overflow-y-auto p-0 scrollbar-sleek"
    >
      <WorkspaceSpaceIssueFreshness
        worktreeId={worktree.worktreeId}
        executionHostId={worktree.executionHostId}
        issueCacheKey={details.issueCacheKey}
      />
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{worktree.displayName}</div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {worktree.repoDisplayName} · {formatBytes(worktree.sizeBytes)}
            </div>
          </div>
          <WorkspaceSpaceStatusBadge worktree={worktree} decisionDetails={details} />
        </div>
      </div>

      <div className="space-y-3 px-4 py-3">
        <DecisionLine
          icon={<Trash2 />}
          label={t(
            'auto.components.status.bar.WorkspaceSpaceManagerPanel.d384a4ce9f',
            'Delete decision'
          )}
          value={deleteDecision}
          tone={worktree.canDelete && worktree.status === 'ok' ? 'default' : 'warning'}
        />
        <DecisionLine
          icon={<Bot />}
          label={t('auto.components.status.bar.WorkspaceSpaceManagerPanel.a8d9e0de79', 'Agents')}
          value={getAgentDecisionLabel(details, t)}
        />
        <DecisionLine
          icon={<Terminal />}
          label={t('auto.components.status.bar.WorkspaceSpaceManagerPanel.e9528a89b3', 'Terminals')}
          value={getTerminalDecisionLabel(details, t)}
        />
        <DecisionLine
          icon={<FileWarning />}
          label={t(
            'auto.components.status.bar.WorkspaceSpaceManagerPanel.0bc756efaf',
            'Git changes'
          )}
          value={getGitDecisionLabel(details, gitRefreshState, t)}
          tone={
            (details.changedFileCount ?? 0) > 0 || gitRefreshState?.error ? 'warning' : 'default'
          }
        />
        <DecisionLine
          icon={<FileWarning />}
          label={t(
            'auto.components.status.bar.WorkspaceSpaceManagerPanel.c432278ec7',
            'Editor buffers'
          )}
          value={getEditorDecisionLabel(details, t)}
          tone={details.dirtyEditorBufferCount > 0 ? 'warning' : 'default'}
        />
        <DecisionLine
          icon={<GitBranch />}
          label={t('auto.components.status.bar.WorkspaceSpaceManagerPanel.b9b4a3a25d', 'Branch')}
          value={details.branchStatus ?? getWorkspaceSpaceBranchLabel(worktree, t)}
        />
        <DecisionLine
          icon={<GitPullRequest />}
          label={t('auto.components.status.bar.WorkspaceSpaceManagerPanel.fb2069acb7', 'Review')}
          value={
            details.reviewLabel ??
            t('auto.components.status.bar.workspaceSpaceDecision.noLinkedReview', 'No linked PR')
          }
        />
        <DecisionLine
          icon={<ExternalLink />}
          label={t('auto.components.status.bar.WorkspaceSpaceManagerPanel.66870929fb', 'Issue')}
          value={issueLabel}
        />
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-3">
        <div className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          {details.browserTabCount > 0
            ? t(
                'auto.components.status.bar.workspaceSpaceDecision.browserTabsOpen',
                '{{count}} browser tabs open',
                { count: details.browserTabCount, defaultValue_one: '{{count}} browser tab open' }
              )
            : worktree.path}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onOpenWorkspace()
          }}
          disabled={!details.canOpenWorkspace}
          className="shrink-0 gap-1.5"
        >
          <ExternalLink className="size-3.5" />
          {t('auto.components.status.bar.WorkspaceSpaceManagerPanel.c28643d3da', 'Go to workspace')}
        </Button>
      </div>
    </HoverCardContent>
  )
}
