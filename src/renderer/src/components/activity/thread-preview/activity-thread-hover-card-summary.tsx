import React, { useCallback, useMemo } from 'react'
import { LocateFixed } from 'lucide-react'
import { useAppStore } from '@/store/index'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import { formatAgentTypeLabel } from '../../../../../shared/agent-status/presentation/agent-type-label'
import { jumpToWorktreeFromSidebar } from '@/lib/workspace/activation/worktree-jump-navigation'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  getWorktreeExecutionHostId,
  parseExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { getHostDisplayLabelOverrides } from '../../../../../shared/execution-host/host-setting-overrides'
import CommentMarkdown from '../../comment-markdown/CommentMarkdown'
import { getTranslatedExecutionHostLabel } from '../../../runtime/hosts/display/execution-host-label'
import { MetadataActionIcon } from '../../sidebar/workspace-card/metadata/WorktreeCardMetadataControls'
import { EventTime, ThreadAgentStateIndicator } from '../thread-list/activity-thread-controls'
import {
  activityThreadRowCopy,
  threadAgentStateLabel
} from '../threads/activity-thread-presentation'
import type { AgentPaneThread } from '../threads/activity-thread-types'

function IdentityPart({ label }: { label: string }): React.JSX.Element {
  return (
    <>
      <span className="shrink-0 text-[12px] text-muted-foreground/40">•</span>
      <span
        className="min-w-0 truncate text-[12px] font-medium text-muted-foreground"
        title={label}
      >
        {label}
      </span>
    </>
  )
}

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
  const t = useTranslate()
  const { worktree, repo } = thread
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const executionHostId = getWorktreeExecutionHostId(worktree, repo ?? undefined)
  const parsedHost = parseExecutionHostId(executionHostId)
  const hostLabelOverrides = useMemo(() => getHostDisplayLabelOverrides(settings), [settings])
  // The local machine is the default; only another host is worth naming in the preview.
  const remoteHostLabel = useMemo(() => {
    if (!parsedHost || parsedHost.kind === 'local') {
      return null
    }
    const override = hostLabelOverrides.get(executionHostId)
    if (override) {
      return override
    }
    if (parsedHost.kind === 'runtime') {
      const environment = runtimeEnvironments.find((entry) => entry.id === parsedHost.environmentId)
      if (environment?.name) {
        return environment.name
      }
    }
    if (parsedHost.kind === 'ssh') {
      const target = sshTargetLabels.get(parsedHost.targetId)
      if (target) {
        return target
      }
    }
    return getTranslatedExecutionHostLabel(executionHostId)
  }, [executionHostId, hostLabelOverrides, parsedHost, runtimeEnvironments, sshTargetLabels])
  const { taskTitle, needsAttention, projectLabel } = activityThreadRowCopy(thread, t)

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
          state.acknowledgeAgents([thread.paneKey], undefined, 'explicit')
          jumpToWorktreeFromSidebar(worktree.id, { executionHostId })
        }
      }
    },
    [executionHostId, onJumpToWorkspace, thread.paneKey, worktree.id]
  )

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="inline-flex shrink-0">
            <AgentTypeIcon agentType={thread.agentType} size={14} />
          </span>
          <span className="shrink-0 text-[12px] font-semibold text-foreground">
            {formatAgentTypeLabel(thread.agentType)}
          </span>
          <IdentityPart label={projectLabel} />
          {remoteHostLabel ? <IdentityPart label={remoteHostLabel} /> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <ThreadAgentStateIndicator thread={thread} />
          <span
            className={cn(
              'text-[11px] font-medium capitalize',
              needsAttention ? 'text-agent-question-text' : 'text-muted-foreground'
            )}
          >
            {threadAgentStateLabel(thread, t)}
          </span>
          <span className="text-muted-foreground/40">•</span>
          <EventTime timestamp={thread.latestTimestamp} compact />
          {canJump ? (
            <MetadataActionIcon
              label={t(
                'auto.components.activity.ActivityThreadHoverCard.jumpToWorkspace',
                'Jump to workspace'
              )}
              onClick={handleJumpToWorkspace}
            >
              <LocateFixed className="size-3" />
            </MetadataActionIcon>
          ) : null}
        </div>
      </div>

      <div className="break-words text-[13px] font-semibold leading-snug text-foreground">
        {taskTitle}
      </div>

      {thread.responsePreview ? (
        <div className="max-h-36 overflow-y-auto break-words rounded-md border border-border/40 bg-accent/40 p-2 text-[11.5px] leading-relaxed text-foreground/80 scrollbar-sleek">
          <CommentMarkdown
            content={thread.responsePreview}
            singleTildeStrikethrough={false}
            className="text-[11.5px] leading-relaxed [&_*]:!m-0 [&_*]:!p-0"
          />
        </div>
      ) : null}
    </div>
  )
}
