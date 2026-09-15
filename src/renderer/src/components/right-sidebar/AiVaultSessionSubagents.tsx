import { useId } from 'react'
import type React from 'react'
import { Bot, ChevronRight, FileJson, Play } from 'lucide-react'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  SubagentExpansionProvider,
  subagentTranscriptKey,
  useSubagentExpansion
} from './ai-vault-subagent-expansion'
import { useSubagentSessions } from './use-subagent-sessions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AgentStateDot, type AgentDotState } from '@/components/AgentStateDot'
import {
  isAiVaultSessionResumableContent,
  type AiVaultSession,
  type AiVaultSubagentRunStatus
} from '../../../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { canOpenAiVaultSessionLogInOrca } from './ai-vault-session-path-actions'
import { openAiVaultSessionLogInOrca } from './ai-vault-session-log-open'
import { translate } from '@/i18n/i18n'
import {
  aiVaultSessionResumeLabel,
  type AiVaultSessionResumeState
} from './ai-vault-session-resume'

export type AiVaultSubagentResumeActions = {
  getState: (session: AiVaultSession) => AiVaultSessionResumeState
  onResume: (session: AiVaultSession, worktreeId: string) => void
}

function isIndependentlyResumableSubagent(session: AiVaultSession): boolean {
  return (
    session.agent === 'omp' &&
    Boolean(session.subagent) &&
    Boolean(session.sessionId.trim()) &&
    session.sessionId !== session.subagent?.parentSessionId &&
    Boolean(session.filePath.trim()) &&
    isAiVaultSessionResumableContent(session)
  )
}

type SectionProps = { session: AiVaultSession; resume?: AiVaultSubagentResumeActions }

export function SessionSubagentsSection(props: SectionProps): React.JSX.Element | null {
  const expansion = useSubagentExpansion()

  if (
    props.session.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
    props.session.subagentTranscriptCount === 0
  ) {
    return null
  }

  const key = subagentTranscriptKey(props.session)
  const branch = <SubagentsBranch key={key} {...props} ancestors={[key]} />

  return expansion ? (
    branch
  ) : (
    <SubagentExpansionProvider key={key}>{branch}</SubagentExpansionProvider>
  )
}

function SubagentsBranch({
  session,
  resume,
  ancestors
}: SectionProps & { ancestors: string[] }): React.JSX.Element {
  const subagents = useSubagentSessions(session)

  return (
    <section className="space-y-1.5" aria-busy={subagents.status === 'loading'}>
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        <Bot className="size-3" />
        <span>
          {translate(
            'auto.components.right.sidebar.AiVaultSessionSubagents.subagentsCount',
            'Subagents ({{value0}})',
            { value0: subagents.sessions.length }
          )}
        </span>
      </div>
      {subagents.showLoading ? (
        <p role="status" className="text-xs text-muted-foreground">
          {translate('aiVault.subagents.loading', 'Loading subagents…')}
        </p>
      ) : null}
      {subagents.status === 'error' ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <span>{translate('aiVault.subagents.loadError', 'Could not load all subagents.')}</span>
          <Button
            variant="ghost"
            size="xs"
            onClick={(event) => {
              event.stopPropagation()
              subagents.retry()
            }}
          >
            {translate('common.retry', 'Retry')}
          </Button>
        </div>
      ) : null}
      {subagents.status === 'loaded' && subagents.sessions.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate('aiVault.subagents.empty', 'No subagents found.')}
        </p>
      ) : null}
      <div className="space-y-1.5">
        {subagents.sessions.map((child) => (
          <SubagentBranchRow
            key={subagentTranscriptKey(child)}
            session={child}
            resume={resume}
            ancestors={ancestors}
          />
        ))}
      </div>
    </section>
  )
}

function SubagentBranchRow({
  session,
  resume,
  ancestors
}: SectionProps & { ancestors: string[] }): React.JSX.Element {
  const expansion = useSubagentExpansion()
  const contentId = useId()
  const locator = subagentTranscriptKey(session)
  const key = JSON.stringify([...ancestors, locator])

  const expandable =
    session.agent === 'omp' &&
    session.executionHostId === LOCAL_EXECUTION_HOST_ID &&
    session.subagentTranscriptCount > 0 &&
    !ancestors.includes(locator)

  const open = expandable && Boolean(expansion?.expanded.has(key))

  const label = translate(
    'auto.components.right.sidebar.AiVaultSessionSubagents.subagentsCount',
    'Subagents ({{value0}})',
    { value0: session.subagentTranscriptCount }
  )

  return (
    <Collapsible open={open} onOpenChange={(value) => expansion?.setExpanded(key, value)}>
      <SubagentSessionLine
        session={session}
        resume={resume}
        disclosure={
          expandable ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <CollapsibleTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={label}
                    aria-controls={contentId}
                    onClick={(event) => event.stopPropagation()}
                    className="shrink-0 text-muted-foreground"
                  >
                    <ChevronRight className={cn('size-3.5', open && 'rotate-90')} />
                  </Button>
                </CollapsibleTrigger>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ) : null
        }
      />
      <CollapsibleContent
        id={contentId}
        className={cn('space-y-1.5 pt-1.5', ancestors.length < 4 && 'pl-3')}
      >
        {open ? (
          <SubagentsBranch session={session} resume={resume} ancestors={[...ancestors, locator]} />
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}

// AI Vault run statuses map onto the shared dot vocabulary: a completed Task
// is an outcome ('done'), stopped/killed reads as an interruption.
const SUBAGENT_DOT_STATES: Record<AiVaultSubagentRunStatus, AgentDotState> = {
  running: 'working',
  completed: 'done',
  failed: 'failed',
  stopped: 'interrupted'
}

function SubagentSessionLine({
  session,
  resume,
  disclosure
}: {
  session: AiVaultSession
  resume?: AiVaultSubagentResumeActions
  disclosure?: React.ReactNode
}): React.JSX.Element {
  const resumeState =
    resume && isIndependentlyResumableSubagent(session) ? resume.getState(session) : null

  const dotState = session.subagent?.status ? SUBAGENT_DOT_STATES[session.subagent.status] : null

  return (
    <div className="min-w-0 space-y-1.5 rounded-md border border-sidebar-border/70 bg-sidebar-accent/25 px-2.5 py-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        {disclosure}
        {dotState ? (
          // Why: a plain inline span would baseline-align the dot; flex keeps it
          // vertically centered with the row text.
          <span className="flex shrink-0 items-center">
            <AgentStateDot state={dotState} />
          </span>
        ) : null}
        <span
          className="min-w-0 flex-1 truncate text-[12px] leading-[1.35] text-foreground/90"
          title={session.title}
        >
          {session.title}
        </span>
        {resumeState ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            draggable={false}
            disabled={resumeState.blocked || !resumeState.worktreeId}
            title={aiVaultSessionResumeLabel(resumeState)}
            aria-label={aiVaultSessionResumeLabel(resumeState)}
            onClick={(event) => {
              event.stopPropagation()

              if (resumeState.worktreeId && !resumeState.blocked) {
                resume?.onResume(session, resumeState.worktreeId)
              }
            }}
            className="shrink-0 text-muted-foreground"
          >
            <Play className="size-3.5" />
          </Button>
        ) : null}
        {canOpenAiVaultSessionLogInOrca(session) ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            draggable={false}
            title={translate(
              'auto.components.right.sidebar.AiVaultSessionSubagents.viewLog',
              'View Log'
            )}
            onClick={(event) => {
              event.stopPropagation()
              void openAiVaultSessionLogInOrca(session)
            }}
            className="shrink-0 text-muted-foreground"
          >
            <FileJson className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        {session.subagent?.agentType ? (
          <Badge
            variant="outline"
            className="h-5 min-w-0 truncate border-border/70 bg-background px-1.5 py-0 text-[10px] font-medium"
          >
            {session.subagent.agentType}
          </Badge>
        ) : null}
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.AiVaultSessionSubagents.messageCount',
            '{{value0}} msgs',
            { value0: session.messageCount }
          )}
        </span>
      </div>
    </div>
  )
}
