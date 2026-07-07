import type React from 'react'
import { Badge } from '@/components/ui/badge'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { AgentIcon } from '@/lib/agent-catalog'
import { useRepoById } from '@/store/selectors'
import { resolveRepoBadgeColor } from '../../../../shared/repo-badge-color'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree-id'
import type { AiVaultScope, AiVaultSession } from '../../../../shared/ai-vault-types'
import { translate } from '@/i18n/i18n'
import { SessionTime } from './AiVaultSessionDetails'
import { agentLabel } from './ai-vault-session-filters'
import {
  aiVaultWorktreeStatusLabel,
  shouldShowAiVaultWorktreeStatusBadge,
  shouldShowAiVaultSessionWorktreeLine,
  type AiVaultSessionWorktreeInfo
} from './ai-vault-session-worktree'

export function getSessionDetailsId(sessionId: string): string {
  return `ai-vault-session-details-${sessionId.replace(/[^A-Za-z0-9_-]/g, '-')}`
}

export function SessionMetadata({
  session,
  updatedAt,
  worktreeInfo,
  vaultScope
}: {
  session: AiVaultSession
  updatedAt: string
  worktreeInfo: AiVaultSessionWorktreeInfo | null
  vaultScope: AiVaultScope
}) {
  return (
    <div className="mt-1 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-1.5 gap-y-0.5 text-[11px] leading-4 text-muted-foreground">
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        <AgentIcon agent={session.agent} size={14} />
      </span>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate">{agentLabel(session.agent)}</span>
        <span className="shrink-0 tabular-nums">
          {translate(
            'auto.components.right.sidebar.AiVaultSessionRow.messageCount',
            '{{value0}} msgs',
            { value0: session.messageCount }
          )}
        </span>
        <span className="shrink-0 text-muted-foreground/55">·</span>
        <SessionTime value={updatedAt} />
      </div>
      {shouldShowAiVaultSessionWorktreeLine(worktreeInfo, { vaultScope }) ? (
        <div className="col-span-2 min-w-0">
          <SessionWorktreeLine worktreeInfo={worktreeInfo} vaultScope={vaultScope} />
        </div>
      ) : null}
    </div>
  )
}

export function SessionWorktreeLine({
  worktreeInfo,
  vaultScope
}: {
  worktreeInfo: AiVaultSessionWorktreeInfo
  vaultScope: AiVaultScope
}): React.JSX.Element {
  const repoId = worktreeInfo.worktreeId
    ? (splitWorktreeIdForFilesystem(worktreeInfo.worktreeId)?.repoId ?? null)
    : null
  const repo = useRepoById(repoId)

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 pl-5">
      {shouldShowAiVaultWorktreeStatusBadge(worktreeInfo.status, { vaultScope }) ? (
        <span className="shrink-0 rounded-sm border border-sidebar-border bg-sidebar-accent/45 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
          {worktreeStatusLabel(worktreeInfo.status)}
        </span>
      ) : null}
      <Badge
        variant="outline"
        className="h-5 max-w-full gap-1 border-border/70 bg-background px-1.5 py-0 text-[11px] font-medium"
        title={worktreeInfo.label}
      >
        <RepoBadgeLabel
          name={worktreeInfo.label}
          color={resolveRepoBadgeColor(repo?.badgeColor)}
          className="min-w-0 max-w-full"
          badgeClassName="size-1.5"
        />
      </Badge>
    </div>
  )
}

function worktreeStatusLabel(status: AiVaultSessionWorktreeInfo['status']): string {
  return aiVaultWorktreeStatusLabel(status)
}

export function conversationRoleLabel(
  role: AiVaultSession['previewMessages'][number]['role']
): string {
  if (role === 'user') {
    return translate('auto.components.right.sidebar.AiVaultSessionRow.userRole', 'You')
  }
  if (role === 'assistant') {
    return translate('auto.components.right.sidebar.AiVaultSessionRow.agentRole', 'Agent')
  }
  if (role === 'tool') {
    return translate('auto.components.right.sidebar.AiVaultSessionRow.toolRole', 'Tool')
  }
  if (role === 'system') {
    return translate('auto.components.right.sidebar.AiVaultSessionRow.systemRole', 'System')
  }
  return translate('auto.components.right.sidebar.AiVaultSessionRow.sessionRole', 'Session')
}
