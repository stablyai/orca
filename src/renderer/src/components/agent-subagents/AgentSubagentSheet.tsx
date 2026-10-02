import { useMemo, useState } from 'react'
import { ArrowLeft, Bot, ChevronRight, LoaderCircle } from 'lucide-react'
import { AgentStateDot, agentStateLabel } from '@/components/AgentStateDot'
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
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { NativeChatMessageList } from '../native-chat/NativeChatMessageList'
import { useNativeChatLiveSession } from '../native-chat/use-native-chat-live-session'
import {
  subagentDisplayName,
  subagentStatusDot,
  type AgentSubagentSourceData,
  type SubagentSelection
} from './AgentSubagentContext'
import { projectSubagentTranscript } from './subagent-transcript-projection'
import { useAgentSubagentSessions } from './use-agent-subagent-sessions'
import { splitSubagentRows, type SubagentRow } from './subagent-list-rows'
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
  const siblings = useAgentSubagentSessions({
    target: storedSelection?.sourceData.source.target ?? LOCAL_TARGET,
    agent: storedSelection?.sourceData.source.agent ?? '',
    structuredSessionId:
      open && storedSelection?.parentFilePath
        ? storedSelection.sourceData.source.structuredSessionId
        : undefined,
    parentFilePath: open ? (storedSelection?.parentFilePath ?? null) : null
  })
  const selected = storedSelection
    ? reconcileSelection(storedSelection, data, siblings.sessions)
    : null
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
        data-room-activity-stack-portal
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
              setStack((current) => [
                ...current,
                {
                  sourceData: selected.sourceData,
                  session,
                  parentFilePath: selected.session.filePath
                }
              ])
            }
          />
        ) : (
          <SubagentList sourceDatas={data} onOpen={(selection) => setStack([selection])} />
        )}
      </SheetContent>
    </Sheet>
  )
}

const LOCAL_TARGET = { kind: 'local' } as const

function reconcileSelection(
  selection: SubagentSelection,
  data: AgentSubagentSourceData[],
  siblings: AiVaultSession[]
): SubagentSelection {
  const sourceData = data.find((row) => row.source.key === selection.sourceData.source.key)
  const session = (selection.parentFilePath ? siblings : sourceData?.sessions)?.find(
    (row) => row.sessionId === selection.session.sessionId
  )
  return session
    ? { ...selection, sourceData: sourceData ?? selection.sourceData, session }
    : selection
}

function SubagentList({
  sourceDatas,
  onOpen
}: {
  sourceDatas: AgentSubagentSourceData[]
  onOpen: (selection: SubagentSelection) => void
}): React.JSX.Element {
  const { active, done, unknown } = useMemo(
    () =>
      sourceDatas.reduce<{ active: SubagentRow[]; done: SubagentRow[]; unknown: SubagentRow[] }>(
        (rows, sourceData) => {
          const split = splitSubagentRows(sourceData, sourceDatas.length > 1)
          rows.active.push(...split.active)
          rows.done.push(...split.done)
          rows.unknown.push(...split.unknown)
          return rows
        },
        { active: [], done: [], unknown: [] }
      ),
    [sourceDatas]
  )
  const source = sourceDatas.length === 1 ? sourceDatas[0]?.source : null
  const identity = source?.showIdentity === false ? null : source?.identity
  return (
    <>
      <SheetHeader bordered>
        <SheetTitle>
          <span className="flex items-center gap-2">
            <Bot className="size-4" />
            {identity
              ? translate('agentSubagents.forAgent', '@{{identity}} subagents', { identity })
              : translate('agentSubagents.label', 'Subagents')}
          </span>
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
          title={translate('agentSubagents.active', 'Active')}
          rows={active}
          loading={sourceDatas.some((sourceData) => sourceData.loading)}
          onOpen={onOpen}
        />
        <SubagentSection
          title={translate('agentSubagents.done', 'Done')}
          rows={done}
          loading={false}
          onOpen={onOpen}
        />
        {unknown.length > 0 ? (
          <SubagentSection
            title={translate('agentSubagents.statusUnavailable', 'Status unavailable')}
            rows={unknown}
            loading={false}
            onOpen={onOpen}
          />
        ) : null}
      </div>
    </>
  )
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
                  {row.subtitle ??
                    (row.session
                      ? translate('agentSubagents.readOnlyTranscript', 'Read-only transcript')
                      : translate('agentSubagents.transcriptStarting', 'Transcript starting…'))}
                </span>
              </span>
              {row.session?.model ? (
                <Badge variant="outline" size="caption" className="max-w-28">
                  <span className="truncate">{row.session.model}</span>
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
          {loading
            ? translate('agentSubagents.loading', 'Loading…')
            : translate('agentSubagents.none', 'None')}
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
    parentFilePath: session.filePath,
    structuredSessionId: sourceData.source.structuredSessionId,
    poll: session.subagent?.status === 'running'
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
      messages: projectSubagentTranscript(
        transcript.messages,
        sourceData.source.identity,
        sourceData.source.showIdentity
      )
    }),
    [transcript, sourceData.source.identity, sourceData.source.showIdentity]
  )
  const liveSubagent = sourceData.source.liveSubagents.find(
    (subagent) => subagent.id === session.sessionId
  )
  const working = Boolean(liveSubagent) || session.subagent?.status === 'running'
  const displayName = subagentDisplayName(session.title, session.subagent?.agentType)
  return (
    <>
      <SheetHeader bordered>
        <div className="flex min-w-0 items-center gap-2">
          <Button type="button" variant="ghost" size="icon-sm" onClick={onBack}>
            <ArrowLeft />
          </Button>
          <div className="min-w-0 flex-1">
            <SheetTitle>
              <span className="block truncate">{displayName}</span>
            </SheetTitle>
            <SheetDescription>
              <span className="block truncate">
                {sourceData.source.showIdentity === false
                  ? translate(
                      'agentSubagents.transcriptDescriptionAnonymous',
                      'Read-only subagent transcript'
                    )
                  : translate(
                      'agentSubagents.transcriptDescription',
                      '@{{identity}} · Read-only subagent transcript',
                      { identity: sourceData.source.identity }
                    )}
              </span>
            </SheetDescription>
          </div>
          <Badge variant="outline">
            {working
              ? translate('agentSubagents.active', 'Active')
              : session.subagent?.status == null
                ? translate('agentSubagents.statusUnavailable', 'Status unavailable')
                : session.subagent.status === 'completed'
                  ? translate('agentSubagents.done', 'Done')
                  : agentStateLabel(subagentStatusDot(session))}
          </Badge>
        </div>
      </SheetHeader>
      {nested.sessions.length > 0 ? (
        <div className="border-b border-border px-4 py-2">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {translate('agentSubagents.nested', 'Nested agents')}
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
