import React from 'react'
import { Folder, GitBranch } from 'lucide-react'
import { AgentStateDot, agentStateLabel, type AgentDotState } from '@/components/AgentStateDot'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { CommentMarkdownAsync } from './comment-markdown-lazy'
import { WorktreeHoverFactGrid } from './worktree-hover-fact-grid'
import { getWorktreeHoverContextTitle, type WorktreeHoverFacts } from './worktree-hover-facts'

/** A card previews; past this many children the rest becomes a count. */
const MAX_LISTED_SUBAGENTS = 5

const MESSAGE_CLASS_NAME =
  'text-[11.5px] text-muted-foreground break-words leading-normal [&_.comment-md-p]:block [&_.comment-md-p+.comment-md-p]:mt-1'

export type WorktreeHoverSubagent = {
  id: string
  name: string
  dotState: AgentDotState
}

export type WorktreeHoverSession = {
  agentType: string
  dotState: AgentDotState
  subagents: WorktreeHoverSubagent[]
  primary: string
  body: string
  bodyIsMarkdown: boolean
  model: string
  timeAgo: string | null
  /** Subagent rows carry a role name in agentType, which has no icon of its own. */
  hideAgentIcon: boolean
}

function WorktreeHoverSessionSection({
  session,
  headed
}: {
  session: WorktreeHoverSession
  /** True when the card above already carries a workspace title. */
  headed: boolean
}): React.JSX.Element {
  const stateLabel = agentStateLabel(session.dotState)
  const agentLabel = formatAgentTypeLabel(session.agentType)
  const visibleSubagents = session.subagents.slice(0, MAX_LISTED_SUBAGENTS)
  const hiddenSubagentCount = session.subagents.length - visibleSubagents.length
  const body =
    session.body &&
    session.body !== session.primary &&
    session.body !== stateLabel &&
    session.body !== agentLabel
      ? session.body
      : ''

  return (
    <div
      className={cn('space-y-1.5', headed && 'border-t border-border/60 pt-2')}
      data-worktree-hover-session=""
    >
      {/* Why: a long model id must not eat the agent name or its state — those two
          are what the row is about, so only the model shrinks. */}
      <div
        className="flex items-center gap-1.5 text-[10.5px] leading-none text-muted-foreground"
        data-worktree-hover-session-header=""
      >
        {!session.hideAgentIcon && (
          <span className="shrink-0">
            <AgentIcon agent={agentTypeToIconAgent(session.agentType)} size={12} />
          </span>
        )}
        <span className="shrink-0">{agentLabel}</span>
        <AgentStateDot state={session.dotState} size="sm" title={null} />
        <span className="shrink-0">{stateLabel}</span>
        {session.model && (
          <span className="min-w-0 flex-1 truncate font-mono">{session.model}</span>
        )}
        {session.timeAgo && (
          <span className="ml-auto shrink-0 tabular-nums">{session.timeAgo}</span>
        )}
      </div>
      {session.primary && (
        <div
          className="line-clamp-3 break-words text-[12.5px] font-medium leading-snug text-foreground"
          data-worktree-hover-prompt=""
        >
          {session.primary}
        </div>
      )}
      {body &&
        (session.bodyIsMarkdown ? (
          <CommentMarkdownAsync
            content={body}
            className={MESSAGE_CLASS_NAME}
            fallbackClassName="whitespace-pre-wrap"
          />
        ) : (
          <div className={cn(MESSAGE_CLASS_NAME, 'whitespace-pre-wrap')}>{body}</div>
        ))}
      {visibleSubagents.length > 0 && (
        <div className="flex flex-col gap-0.5 border-l border-border/70 pl-2">
          {visibleSubagents.map((subagent) => (
            <div
              key={subagent.id}
              className="flex min-w-0 items-center gap-1.5 text-[10.5px] leading-none text-muted-foreground"
              data-worktree-hover-subagent=""
            >
              <AgentStateDot state={subagent.dotState} size="sm" title={null} />
              <span className="min-w-0 truncate">{subagent.name}</span>
            </div>
          ))}
          {hiddenSubagentCount > 0 && (
            <div className="pl-[calc(0.625rem+0.375rem)] text-[10.5px] leading-none text-muted-foreground/70">
              {translate(
                'auto.components.sidebar.worktreeHoverCard.moreSubagents',
                '+{{count}} more',
                { count: hiddenSubagentCount }
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Hover card contents shared by the sidebar rows: what the workspace is, the work
 * it is linked to, and the session under the cursor. Pure — the caller resolves
 * the facts so this renders the same in the app and in a preview.
 */
export function WorktreeHoverCardBody({
  facts,
  session,
  workspaceSlot
}: {
  facts: WorktreeHoverFacts
  session?: WorktreeHoverSession
  /** Chips that need live state; the caller owns the store subscription. */
  workspaceSlot?: React.ReactNode
}): React.JSX.Element {
  const contextTitle = getWorktreeHoverContextTitle(facts, session?.primary)
  const headed = facts.title.trim().length > 0
  // Why: a session whose prompt is the card title would otherwise say it twice.
  const sessionForBody =
    session && session.primary.trim() === facts.title.trim() ? { ...session, primary: '' } : session

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        {headed && (
          <div className="flex items-start gap-2">
            <div
              className="line-clamp-2 min-w-0 flex-1 break-words text-[13px] font-semibold leading-snug text-foreground"
              data-worktree-hover-title=""
            >
              {facts.title}
            </div>
            {facts.activityAgo && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="mt-0.5 shrink-0 text-[10.5px] leading-none tabular-nums text-muted-foreground"
                    aria-label={translate(
                      'auto.components.sidebar.worktreeHoverCard.lastActivity',
                      'Last activity {{ago}} ago',
                      { ago: facts.activityAgo }
                    )}
                  >
                    {facts.activityAgo}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {translate(
                    'auto.components.sidebar.worktreeHoverCard.lastActivity',
                    'Last activity {{ago}} ago',
                    { ago: facts.activityAgo }
                  )}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        )}
        {facts.identity && (
          <div className="flex items-start gap-1 font-mono text-[11px] leading-snug text-muted-foreground">
            {facts.identityKind === 'branch' ? (
              <GitBranch className="mt-px size-3 shrink-0" aria-hidden />
            ) : (
              <Folder className="mt-px size-3 shrink-0" aria-hidden />
            )}
            <span className="line-clamp-2 break-all" data-worktree-hover-identity="">
              {facts.identity}
            </span>
          </div>
        )}
      </div>

      <WorktreeHoverFactGrid facts={facts} workspaceSlot={workspaceSlot} />

      {contextTitle && (
        <div className="line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">
          {contextTitle}
        </div>
      )}

      {facts.note && (
        <div className="line-clamp-3 border-l border-border/70 pl-2 text-[11px] leading-snug text-muted-foreground">
          {facts.note}
        </div>
      )}

      {sessionForBody && <WorktreeHoverSessionSection session={sessionForBody} headed={headed} />}
    </div>
  )
}
