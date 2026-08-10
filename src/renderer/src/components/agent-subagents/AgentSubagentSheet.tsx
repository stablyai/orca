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
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { useAppStore } from '@/store'
import type { AgentSubagentSnapshot } from '../../../../shared/agent-status-types'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { NativeChatMessageList } from '../native-chat/NativeChatMessageList'
import { useNativeChatLiveSession } from '../native-chat/use-native-chat-live-session'
import { subagentDisplayName, type AgentSubagentSourceData } from './AgentSubagentContext'
import { projectSubagentTranscript } from './subagent-transcript-projection'
import { useAgentSubagentSessions } from './use-agent-subagent-sessions'
import {
  clampRightSidebarPanelWidth,
  computeMaxRightSidebarPanelWidth,
  RIGHT_SIDEBAR_MIN_WIDTH
} from '../right-sidebar/right-sidebar-width'

export function AgentSubagentSheet({
  open,
  data,
  initialSelection,
  onOpenChange
}: {
  open: boolean
  data: AgentSubagentSourceData[]
  initialSelection: SubagentSelection | null
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const [stack, setStack] = useState<SubagentSelection[]>(
    initialSelection ? [initialSelection] : []
  )
  const storedSelection = stack.at(-1) ?? null
  const selected = storedSelection ? reconcileSelection(storedSelection, data) : null
  const width = useAppStore((state) => state.subagentSheetWidth)
  const setWidth = useAppStore((state) => state.setSubagentSheetWidth)
  const windowWidth = typeof window === 'undefined' ? null : window.innerWidth
  const renderedWidth = clampRightSidebarPanelWidth(width, windowWidth, 0)
  const { containerRef, onResizeStart } = useSidebarResize<HTMLDivElement>({
    isOpen: true,
    width: renderedWidth,
    minWidth: RIGHT_SIDEBAR_MIN_WIDTH,
    maxWidth: computeMaxRightSidebarPanelWidth(windowWidth, 0),
    deltaSign: -1,
    setWidth
  })

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        ref={containerRef}
        side="right"
        className="w-auto max-w-[calc(100vw-320px)] sm:max-w-none"
        style={{ width: renderedWidth }}
      >
        <div
          role="separator"
          aria-orientation="vertical"
          onMouseDown={onResizeStart}
          className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize hover:bg-primary/35"
        />
        {selected ? (
          <SubagentTranscript
            sourceData={selected.sourceData}
            session={selected.session}
            onBack={() => setStack((current) => current.slice(0, -1))}
            onOpenChild={(session) =>
              setStack((current) => [...current, { sourceData: selected.sourceData, session }])
            }
          />
        ) : (
          <SubagentList sourceDatas={data} onOpen={(selection) => setStack([selection])} />
        )}
      </SheetContent>
    </Sheet>
  )
}

type SubagentSelection = {
  sourceData: AgentSubagentSourceData
  session: AiVaultSession
}

function reconcileSelection(
  selection: SubagentSelection,
  data: AgentSubagentSourceData[]
): SubagentSelection {
  const sourceData = data.find((row) => row.source.key === selection.sourceData.source.key)
  const session = sourceData?.sessions.find((row) => row.sessionId === selection.session.sessionId)
  return sourceData && session ? { sourceData, session } : selection
}

function SubagentList({
  sourceDatas,
  onOpen
}: {
  sourceDatas: AgentSubagentSourceData[]
  onOpen: (selection: SubagentSelection) => void
}): React.JSX.Element {
  const { active, done } = useMemo(
    () =>
      sourceDatas.reduce(
        (rows, sourceData) => {
          const split = splitRows(sourceData, sourceDatas.length > 1)
          rows.active.push(...split.active)
          rows.done.push(...split.done)
          return rows
        },
        { active: [] as SubagentRow[], done: [] as SubagentRow[] }
      ),
    [sourceDatas]
  )
  const identity = sourceDatas.length === 1 ? `@${sourceDatas[0]!.source.identity} ` : ''
  return (
    <>
      <SheetHeader className="border-b border-border pr-12">
        <SheetTitle className="flex items-center gap-2">
          <Bot className="size-4" />
          {identity ? `${identity}subagents` : 'Subagents'}
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
          loading={sourceDatas.some((sourceData) => sourceData.loading)}
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
  sourceData: AgentSubagentSourceData
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
  onOpen: (selection: SubagentSelection) => void
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
              onClick={() =>
                row.session && onOpen({ sourceData: row.sourceData, session: row.session })
              }
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
  const visibleTranscript = useMemo(
    () => ({
      ...transcript,
      messages: projectSubagentTranscript(transcript.messages, sourceData.source.identity)
    }),
    [transcript, sourceData.source.identity]
  )
  const liveSubagent = sourceData.source.liveSubagents.find(
    (subagent) => subagent.id === session.sessionId
  )
  const working = Boolean(liveSubagent) || session.subagent?.status === 'running'
  const displayName = subagentDisplayName(session.title, session.subagent?.agentType)
  return (
    <>
      <SheetHeader className="border-b border-border pr-12">
        <div className="flex min-w-0 items-center gap-2">
          <Button type="button" variant="ghost" size="icon-sm" onClick={onBack}>
            <ArrowLeft />
          </Button>
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate">{displayName}</SheetTitle>
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
                <span className="truncate">
                  {subagentDisplayName(child.title, child.subagent?.agentType)}
                </span>
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
            session={visibleTranscript}
            isWorking={working}
            workingStartedAt={
              liveSubagent?.startedAt ?? Date.parse(session.modifiedAt ?? session.createdAt)
            }
            expandSignal={false}
            fontScale={0.92}
            allowFileUriLinks
          />
        )}
      </div>
    </>
  )
}

function splitRows(
  data: AgentSubagentSourceData,
  showIdentity: boolean
): { active: SubagentRow[]; done: SubagentRow[] } {
  const sessionsById = new Map(data.sessions.map((session) => [session.sessionId, session]))
  const active = data.source.liveSubagents.map((subagent) =>
    liveRow(data, subagent, sessionsById.get(subagent.id) ?? null, showIdentity)
  )
  const activeIds = new Set(active.map((row) => row.id))
  for (const session of data.sessions) {
    if (session.subagent?.status === 'running' && !activeIds.has(session.sessionId)) {
      active.push(sessionRow(data, session, 'working', showIdentity))
      activeIds.add(session.sessionId)
    }
  }
  const done = data.sessions
    .filter((session) => !activeIds.has(session.sessionId))
    .map((session) => sessionRow(data, session, statusDot(session), showIdentity))
  return { active, done }
}

function liveRow(
  sourceData: AgentSubagentSourceData,
  subagent: AgentSubagentSnapshot,
  session: AiVaultSession | null,
  showIdentity: boolean
): SubagentRow {
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
    title: session
      ? subagentDisplayName(session.title, subagent.agentType)
      : subagentDisplayName(subagent.description, subagent.agentType),
    subtitle: `${showIdentity ? `@${sourceData.source.identity} · ` : ''}${agentStateLabel(state)}`,
    state,
    session,
    sourceData
  }
}

function sessionRow(
  sourceData: AgentSubagentSourceData,
  session: AiVaultSession,
  state: AgentDotState,
  showIdentity: boolean
): SubagentRow {
  return {
    id: session.sessionId,
    title: subagentDisplayName(session.title, session.subagent?.agentType),
    subtitle: `${showIdentity ? `@${sourceData.source.identity} · ` : ''}${session.messageCount} messages`,
    state,
    session,
    sourceData
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
