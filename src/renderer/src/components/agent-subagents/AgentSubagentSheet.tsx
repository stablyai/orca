import { useMemo, useState } from 'react'
import { ArrowLeft, Bot, ChevronRight, LoaderCircle } from 'lucide-react'
import { AgentStateDot, agentStateLabel, type AgentDotState } from '@/components/AgentStateDot'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { translate } from '@/i18n/i18n'
import type { AgentSubagentSnapshot } from '../../../../shared/agent-status-types'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { NativeChatMessageList } from '../native-chat/NativeChatMessageList'
import { useNativeChatLiveSession } from '../native-chat/use-native-chat-live-session'
import type { AgentSubagentSourceData } from './AgentSubagentContext'
import { useAgentSubagentSessions } from './use-agent-subagent-sessions'

export function AgentSubagentSheet({
  open,
  data,
  onOpenChange
}: {
  open: boolean
  data: AgentSubagentSourceData | null
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const [stack, setStack] = useState<AiVaultSession[]>([])
  const selected = stack.at(-1) ?? null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[min(760px,92vw)] sm:max-w-[760px]">
        {data ? (
          selected ? (
            <SubagentTranscript
              sourceData={data}
              session={selected}
              onBack={() => setStack((current) => current.slice(0, -1))}
              onOpenChild={(session) => setStack((current) => [...current, session])}
            />
          ) : (
            <SubagentList sourceData={data} onOpen={(session) => setStack([session])} />
          )
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function SubagentList({
  sourceData,
  onOpen
}: {
  sourceData: AgentSubagentSourceData
  onOpen: (session: AiVaultSession) => void
}): React.JSX.Element {
  const { active, done } = useMemo(() => splitRows(sourceData), [sourceData])
  return (
    <>
      <SheetHeader className="border-b border-border pr-12">
        <SheetTitle className="flex items-center gap-2">
          <Bot className="size-4" />@{sourceData.source.identity} subagents
        </SheetTitle>
        <SheetDescription>
          {translate(
            'agentSubagents.description',
            'Open a child transcript without leaving the parent conversation.'
          )}
        </SheetDescription>
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-sleek">
        <SubagentSection
          title="Active"
          rows={active}
          loading={sourceData.loading}
          onOpen={onOpen}
        />
        <SubagentSection title="Done" rows={done} loading={false} onOpen={onOpen} />
      </div>
    </>
  )
}

type SubagentRow = {
  id: string
  title: string
  subtitle: string | null
  state: AgentDotState
  session: AiVaultSession | null
}

function SubagentSection({
  title,
  rows,
  loading,
  onOpen
}: {
  title: string
  rows: SubagentRow[]
  loading: boolean
  onOpen: (session: AiVaultSession) => void
}): React.JSX.Element {
  return (
    <section className="mb-5 last:mb-0">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span>{title}</span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px]">{rows.length}</span>
        {loading ? <LoaderCircle className="size-3 animate-spin" /> : null}
      </div>
      {rows.length > 0 ? (
        <div className="space-y-1.5">
          {rows.map((row) => (
            <button
              key={row.id}
              type="button"
              disabled={!row.session}
              onClick={() => row.session && onOpen(row.session)}
              className="flex w-full items-center gap-3 rounded-lg border border-border/70 bg-card px-3 py-2.5 text-left hover:bg-accent disabled:cursor-default disabled:opacity-80"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-background">
                <AgentStateDot state={row.state} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{row.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {row.subtitle ?? (row.session ? 'Read-only transcript' : 'Transcript starting…')}
                </span>
              </span>
              {row.session?.model ? (
                <Badge variant="outline" className="max-w-28 truncate text-[10px]">
                  {row.session.model}
                </Badge>
              ) : null}
              {row.session ? (
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              ) : null}
            </button>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">
          {loading ? 'Loading…' : 'None'}
        </div>
      )}
    </section>
  )
}

function SubagentTranscript({
  sourceData,
  session,
  onBack,
  onOpenChild
}: {
  sourceData: AgentSubagentSourceData
  session: AiVaultSession
  onBack: () => void
  onOpenChild: (session: AiVaultSession) => void
}): React.JSX.Element {
  const nested = useAgentSubagentSessions({
    target: sourceData.source.target,
    agent: sourceData.source.agent,
    parentFilePath: session.filePath
  })
  const transcript = useNativeChatLiveSession({
    paneKey: `subagent:${session.sessionId}`,
    agent: sourceData.source.agent,
    sessionId: session.sessionId,
    transcriptPath: session.filePath,
    runtimeEnvironmentId: sourceData.source.runtimeEnvironmentId
  })
  const working = session.subagent?.status === 'running'
  return (
    <>
      <SheetHeader className="border-b border-border pr-12">
        <div className="flex min-w-0 items-center gap-2">
          <Button type="button" variant="ghost" size="icon-sm" onClick={onBack}>
            <ArrowLeft />
          </Button>
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate">{session.title}</SheetTitle>
            <SheetDescription className="truncate">
              @{sourceData.source.identity} · Read-only subagent transcript
            </SheetDescription>
          </div>
          <Badge variant="outline">{working ? 'Active' : 'Done'}</Badge>
        </div>
      </SheetHeader>
      {nested.sessions.length > 0 ? (
        <div className="border-b border-border px-4 py-2">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Nested agents
          </div>
          <div className="flex flex-wrap gap-1.5">
            {nested.sessions.map((child) => (
              <Button
                key={child.id}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onOpenChild(child)}
                className="max-w-full"
              >
                <Bot className="size-3.5" />
                <span className="truncate">{child.title}</span>
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">
        {transcript.status === 'error' ? (
          <div className="m-auto text-sm text-destructive">{transcript.error}</div>
        ) : (
          <NativeChatMessageList
            session={transcript}
            isWorking={working}
            workingStartedAt={Date.parse(session.createdAt ?? session.modifiedAt)}
            expandSignal={false}
            fontScale={0.92}
            allowFileUriLinks
          />
        )}
      </div>
    </>
  )
}

function splitRows(data: AgentSubagentSourceData): { active: SubagentRow[]; done: SubagentRow[] } {
  const sessionsById = new Map(data.sessions.map((session) => [session.sessionId, session]))
  const active = data.source.liveSubagents.map((subagent) =>
    liveRow(subagent, sessionsById.get(subagent.id) ?? null)
  )
  const activeIds = new Set(active.map((row) => row.id))
  for (const session of data.sessions) {
    if (session.subagent?.status === 'running' && !activeIds.has(session.sessionId)) {
      active.push(sessionRow(session, 'working'))
      activeIds.add(session.sessionId)
    }
  }
  const done = data.sessions
    .filter((session) => !activeIds.has(session.sessionId))
    .map((session) => sessionRow(session, statusDot(session)))
  return { active, done }
}

function liveRow(subagent: AgentSubagentSnapshot, session: AiVaultSession | null): SubagentRow {
  const state: AgentDotState =
    subagent.state === 'blocked'
      ? 'blocked'
      : subagent.state === 'idle'
        ? 'waiting'
        : subagent.state === 'waiting'
          ? 'waiting'
          : 'working'
  return {
    id: subagent.id,
    title: subagent.description ?? subagent.agentType ?? subagent.id,
    subtitle: agentStateLabel(state),
    state,
    session
  }
}

function sessionRow(session: AiVaultSession, state: AgentDotState): SubagentRow {
  return {
    id: session.sessionId,
    title: session.title,
    subtitle: `${session.messageCount} messages`,
    state,
    session
  }
}

function statusDot(session: AiVaultSession): AgentDotState {
  if (session.subagent?.status === 'failed') {
    return 'failed'
  }
  if (session.subagent?.status === 'stopped') {
    return 'interrupted'
  }
  return 'done'
}
