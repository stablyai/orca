import { useEffect, useState } from 'react'
import type React from 'react'
import { Bot, FileJson } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AgentStateDot, agentStateLabel, type AgentDotState } from '@/components/AgentStateDot'
import type { AiVaultSession, AiVaultSubagentRunStatus } from '../../../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { canOpenAiVaultSessionLogInOrca } from './ai-vault-session-path-actions'
import { openAiVaultSessionLogInOrca } from './ai-vault-session-log-open'
import { translate } from '@/i18n/i18n'

type SubagentListState = { status: 'loading' } | { status: 'loaded'; sessions: AiVaultSession[] }

/**
 * Lists the Task subagent transcripts spawned by one session, fetched on
 * demand when the parent's details expand. Subagents share the parent's
 * sessionId and aren't independently resumable, so rows are view-only.
 */
export function SessionSubagentsSection({
  session
}: {
  session: AiVaultSession
}): React.JSX.Element | null {
  const subagents = useSubagentSessions(session)

  if (subagents.status !== 'loaded' || subagents.sessions.length === 0) {
    return null
  }

  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        <span className="text-muted-foreground/80">
          <Bot className="size-3" />
        </span>
        <span>
          {translate(
            'auto.components.right.sidebar.AiVaultSessionSubagents.subagentsCount',
            'Subagents ({{value0}})',
            { value0: subagents.sessions.length }
          )}
        </span>
      </div>
      <div className="space-y-1.5">
        {subagents.sessions.map((subagentSession) => (
          <SubagentSessionLine key={subagentSession.id} session={subagentSession} />
        ))}
      </div>
    </section>
  )
}

function useSubagentSessions(session: AiVaultSession): SubagentListState {
  const [state, setState] = useState<SubagentListState>({ status: 'loading' })

  useEffect(() => {
    // The scan already counted the transcripts; skip the IPC round-trip when
    // there is nothing to list. Remote sessions can carry a count (from the
    // remote walk listing), but their transcripts aren't local files to list.
    if (
      session.subagentTranscriptCount === 0 ||
      session.executionHostId !== LOCAL_EXECUTION_HOST_ID
    ) {
      setState({ status: 'loaded', sessions: [] })
      return
    }
    let cancelled = false
    // Why: rescans re-run this effect (modifiedAt changes); resetting to
    // loading would unmount the section until IPC returns and flicker on
    // every active-session rescan. Keep prior rows visible while refetching.
    setState((prev) => (prev.status === 'loaded' ? prev : { status: 'loading' }))
    window.api.aiVault
      .listSubagentSessions({
        agent: session.agent,
        parentFilePath: session.filePath,
        executionHostId: session.executionHostId
      })
      .then((result) => {
        if (!cancelled) {
          setState({ status: 'loaded', sessions: result.sessions })
        }
      })
      .catch(() => {
        // A failed listing degrades to "no subagents" — the section stays hidden.
        if (!cancelled) {
          setState({ status: 'loaded', sessions: [] })
        }
      })
    return () => {
      cancelled = true
    }
    // Why: modifiedAt changes exactly when the parent transcript is rewritten,
    // so re-listing on it refreshes a subagent's status (e.g. running -> done).
  }, [
    session.agent,
    session.filePath,
    session.executionHostId,
    session.subagentTranscriptCount,
    session.modifiedAt
  ])

  return state
}

// AI Vault run statuses map onto the shared dot vocabulary: a completed Task
// is an outcome ('done'), stopped/killed reads as an interruption.
const SUBAGENT_DOT_STATES: Record<AiVaultSubagentRunStatus, AgentDotState> = {
  running: 'working',
  completed: 'done',
  failed: 'failed',
  stopped: 'interrupted'
}

function SubagentSessionLine({ session }: { session: AiVaultSession }): React.JSX.Element {
  const dotState = session.subagent?.status ? SUBAGENT_DOT_STATES[session.subagent.status] : null

  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-md border border-sidebar-border/70 bg-sidebar-accent/25 px-2.5 py-1.5">
      {dotState ? (
        // Why: a plain inline span would baseline-align the dot; flex keeps it
        // vertically centered with the row text.
        <span className="flex shrink-0 items-center" title={agentStateLabel(dotState)}>
          <AgentStateDot state={dotState} />
        </span>
      ) : null}
      <span
        className="min-w-0 flex-1 truncate text-[12px] leading-[1.35] text-foreground/90"
        title={session.title}
      >
        {session.title}
      </span>
      {session.subagent?.agentType ? (
        <Badge
          variant="outline"
          className="h-5 shrink-0 border-border/70 bg-background px-1.5 py-0 text-[10px] font-medium"
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
  )
}
