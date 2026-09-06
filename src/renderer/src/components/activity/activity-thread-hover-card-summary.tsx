import React, { useCallback, useMemo } from 'react'
import { Cloud, Copy, FolderGit2, GitBranch, Laptop, LocateFixed, Server } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import { jumpToWorktreeFromSidebar } from '@/lib/worktree-jump-navigation'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  getExecutionHostLabel,
  getWorktreeExecutionHostId,
  parseExecutionHostId
} from '../../../../shared/execution-host'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import CommentMarkdown from '../sidebar/CommentMarkdown'
import { DetailHeader, MetadataActionIcon } from '../sidebar/WorktreeCardMetadataControls'
import {
  WorktreeCardDetailSection,
  WorktreeCardDetailSectionContent
} from '../sidebar/WorktreeCardDetailSection'
import { EventTime, ThreadAgentStateIndicator } from './activity-thread-controls'
import { activityThreadRowCopy, threadAgentStateLabel } from './activity-thread-presentation'
import { getActivityThreadWorkspaceTitle } from '@/lib/activity-thread-display'
import type { AgentPaneThread } from './activity-thread-types'

export function ActivityThreadHoverCardSummary({
  thread,
  settings,
  onJumpToWorkspace,
  canJumpToWorkspace
}: {
  thread: AgentPaneThread
  settings: GlobalSettings | null | undefined
  onJumpToWorkspace?: (event: React.MouseEvent) => void
  canJumpToWorkspace?: boolean
}): React.JSX.Element {
  const { worktree, repo } = thread
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const executionHostId = getWorktreeExecutionHostId(worktree, repo ?? undefined)
  const parsedHost = parseExecutionHostId(executionHostId)
  const hostLabelOverrides = useMemo(() => getHostDisplayLabelOverrides(settings), [settings])
  const hostDisplayLabel = useMemo(() => {
    const override = hostLabelOverrides.get(executionHostId)
    if (override) {
      return override
    }
    if (parsedHost?.kind === 'runtime') {
      const environment = runtimeEnvironments.find((entry) => entry.id === parsedHost.environmentId)
      if (environment?.name) {
        return environment.name
      }
    }
    if (parsedHost?.kind === 'ssh') {
      const target = sshTargetLabels.get(parsedHost.targetId)
      if (target) {
        return target
      }
    }
    return getExecutionHostLabel(executionHostId)
  }, [executionHostId, hostLabelOverrides, parsedHost, runtimeEnvironments, sshTargetLabels])
  const branchIdentityDisplay = useMemo(() => getWorktreeGitIdentityDisplay(worktree), [worktree])
  const { taskTitle, needsAttention } = activityThreadRowCopy(thread)
  const workspaceTitle = getActivityThreadWorkspaceTitle(worktree)
  const copyPathLabel = translate(
    'auto.components.activity.ActivityThreadHoverCard.copyPath',
    'Copy path'
  )

  const isKnownWorktree = useAppStore((s) =>
    Boolean(s.getKnownWorktreeById(worktree.id, executionHostId))
  )
  const canJump = canJumpToWorkspace ?? isKnownWorktree

  const handleJumpToWorkspace = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      if (onJumpToWorkspace) {
        onJumpToWorkspace(event)
      } else {
        const state = useAppStore.getState()
        if (state.getKnownWorktreeById(worktree.id, executionHostId)) {
          state.acknowledgeAgents([thread.paneKey])
          jumpToWorktreeFromSidebar(worktree.id, { executionHostId })
        }
      }
    },
    [executionHostId, onJumpToWorkspace, thread.paneKey, worktree.id]
  )

  const handleCopyPath = useCallback(async () => {
    if (!worktree.path) {
      return
    }
    try {
      await window.api.ui.writeClipboardText(worktree.path)
      toast.success(
        translate(
          'auto.components.activity.ActivityThreadHoverCard.pathCopied',
          'Path copied to clipboard'
        )
      )
    } catch {
      toast.error(
        translate(
          'auto.components.activity.ActivityThreadHoverCard.copyPathFailed',
          'Failed to copy path'
        )
      )
    }
  }, [worktree.path])

  return (
    <>
      <div className="space-y-1.5 border-b border-border/40 pb-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="inline-flex shrink-0">
              <AgentIcon agent={agentTypeToIconAgent(thread.agentType)} size={14} />
            </span>
            <span className="truncate text-[12px] font-semibold text-foreground">
              {formatAgentTypeLabel(thread.agentType)}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <ThreadAgentStateIndicator thread={thread} />
            <span
              className={cn(
                'text-[11px] font-medium capitalize',
                needsAttention ? 'text-agent-question-text' : 'text-muted-foreground'
              )}
            >
              {threadAgentStateLabel(thread)}
            </span>
            <span className="text-muted-foreground/40">•</span>
            <EventTime timestamp={thread.latestTimestamp} compact />
          </div>
        </div>

        <div className="break-words text-[13px] font-semibold leading-snug text-foreground">
          {taskTitle}
        </div>

        {thread.responsePreview ? (
          <div className="max-h-36 overflow-y-auto break-words rounded-md border border-border/40 bg-accent/40 p-2 text-[11.5px] leading-relaxed text-foreground/80 scrollbar-sleek">
            <CommentMarkdown
              content={thread.responsePreview}
              className="text-[11.5px] leading-relaxed [&_*]:!m-0 [&_*]:!p-0"
            />
          </div>
        ) : null}
      </div>

      <WorktreeCardDetailSection>
        <DetailHeader
          icon={<FolderGit2 className="size-3 text-muted-foreground" />}
          label={translate(
            'auto.components.activity.ActivityThreadHoverCard.workspace',
            'Workspace'
          )}
          actions={
            canJump ? (
              <MetadataActionIcon
                label={translate(
                  'auto.components.activity.ActivityThreadHoverCard.jumpToWorkspace',
                  'Jump to workspace'
                )}
                onClick={handleJumpToWorkspace}
              >
                <LocateFixed className="size-3" />
              </MetadataActionIcon>
            ) : null
          }
        />
        <WorktreeCardDetailSectionContent className="space-y-2">
          <div className="flex min-w-0 items-center gap-1.5">
            {repo ? (
              <div className="flex shrink-0 items-center gap-1 rounded-[4px] border border-border bg-accent px-1.5 py-0.5 dark:border-border/60 dark:bg-accent/50">
                <RepoBadgeMark color={repo.badgeColor} />
                <span className="max-w-[7rem] truncate text-[10px] font-semibold lowercase text-foreground">
                  {repo.displayName}
                </span>
              </div>
            ) : null}
            <span className="truncate text-[12.5px] font-semibold text-foreground">
              {workspaceTitle}
            </span>
          </div>

          {branchIdentityDisplay ? (
            <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
              <GitBranch className="size-3 shrink-0" />
              <span className="truncate">
                {branchIdentityDisplay.kind === 'branch'
                  ? branchIdentityDisplay.branchName
                  : branchIdentityDisplay.sidebarLabel}
              </span>
            </div>
          ) : null}

          <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            {parsedHost?.kind === 'runtime' ? (
              <Cloud className="size-3 shrink-0" />
            ) : parsedHost?.kind === 'ssh' ? (
              <Server className="size-3 shrink-0" />
            ) : (
              <Laptop className="size-3 shrink-0" />
            )}
            <span className="truncate font-medium">{hostDisplayLabel}</span>
          </div>

          {worktree.path ? (
            <div className="flex items-center justify-between gap-1.5 rounded border border-border/30 bg-accent/40 px-2 py-1 font-mono text-[10.5px] text-muted-foreground">
              <span className="truncate" title={worktree.path}>
                {worktree.path}
              </span>
              <MetadataActionIcon label={copyPathLabel} onClick={handleCopyPath}>
                <Copy className="size-2.5" />
              </MetadataActionIcon>
            </div>
          ) : null}
        </WorktreeCardDetailSectionContent>
      </WorktreeCardDetailSection>
    </>
  )
}
