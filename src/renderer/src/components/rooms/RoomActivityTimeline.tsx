import { useMemo, useState } from 'react'
import { ChevronRight, FileText, Globe2, Pencil, Search, SquareTerminal } from 'lucide-react'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { NativeChatFileDiff } from '../native-chat/native-chat-diff'
import { fileDiffsFromToolCall } from '../native-chat/native-chat-diff'
import { NativeChatDiffView } from '../native-chat/NativeChatDiffView'
import { briefToolArg, formatToolInput } from '../../../../shared/native-chat-tool-summary'
import type {
  NativeChatMessage,
  NativeChatToolResultBlock
} from '../../../../shared/native-chat-types'
import type { RoomActivityKind, RoomCompletedActivity } from '../../../../shared/rooms'
import {
  buildRoomActivitySections,
  formatRoomActivityDuration,
  type RoomActivityToolStep
} from './room-activity-timeline'

const MAX_DETAIL_CHARS = 8_000

export function RoomCompletedActivityTimeline({
  activity
}: {
  activity: RoomCompletedActivity
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const hasDetails = activity.messages.length > 0
  return (
    <div className="mb-2 border-b border-border/60 pb-2">
      <button
        type="button"
        disabled={!hasDetails}
        aria-expanded={hasDetails ? expanded : undefined}
        onClick={() => hasDetails && setExpanded((current) => !current)}
        className={cn(
          'group flex items-center gap-1.5 text-xs text-muted-foreground',
          hasDetails && 'hover:text-foreground'
        )}
      >
        <span>
          Worked for {formatRoomActivityDuration(activity.startedAt, activity.completedAt)}
        </span>
        {hasDetails ? (
          <ChevronRight className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
        ) : null}
      </button>
      {expanded ? <RoomActivityDetails messages={activity.messages} /> : null}
    </div>
  )
}

export function RoomActivityDetails({
  messages,
  fallback
}: {
  messages: NativeChatMessage[]
  fallback?: { kind: RoomActivityKind; detail?: string }
}): React.JSX.Element {
  const sections = useMemo(() => buildRoomActivitySections(messages), [messages])
  return (
    <div className="mt-2 max-h-[min(55vh,32rem)] space-y-3 overflow-y-auto border-l border-border/70 pl-4 pr-2 text-xs scrollbar-sleek">
      {sections.map((section) =>
        section.kind === 'commentary' ? (
          <CommentMarkdown
            key={section.id}
            content={section.text}
            variant="document"
            className="text-xs text-muted-foreground"
            allowFileUriLinks
          />
        ) : (
          <RoomActivityToolGroup key={section.id} tools={section.tools} />
        )
      )}
      {sections.length === 0 && fallback?.detail ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <ActivityKindIcon kind={fallback.kind} />
          <span className="truncate">{fallback.detail}</span>
        </div>
      ) : null}
    </div>
  )
}

export function hasRoomActivityDetails(
  messages: NativeChatMessage[],
  fallbackDetail?: string
): boolean {
  return messages.length > 0 || Boolean(fallbackDetail)
}

function RoomActivityToolGroup({ tools }: { tools: RoomActivityToolStep[] }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [selectedDiff, setSelectedDiff] = useState<NativeChatFileDiff | null>(null)
  const primaryKind = toolGroupPrimaryKind(tools)
  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className="group flex w-full items-center gap-2 text-left text-muted-foreground hover:text-foreground"
      >
        <ActivityKindIcon kind={primaryKind} />
        <span>{toolGroupLabel(tools)}</span>
        <ChevronRight
          className={cn('size-3.5 shrink-0 transition-transform', expanded && 'rotate-90')}
        />
      </button>
      {expanded ? (
        <div className="mt-1.5 space-y-1.5 pl-5">
          {tools.flatMap((tool) => {
            const diffs = fileDiffsFromToolCall(tool.call.name, tool.call.input)
            return diffs.length > 0
              ? diffs.map((diff) => (
                  <FileDiffRow
                    key={`${tool.id}:${diff.path}`}
                    diff={diff}
                    onOpen={() => setSelectedDiff(diff)}
                  />
                ))
              : [<ActivityToolRow key={tool.id} tool={tool} />]
          })}
        </div>
      ) : null}
      <Dialog open={selectedDiff !== null} onOpenChange={(open) => !open && setSelectedDiff(null)}>
        <DialogContent className="max-h-[85vh] min-w-0 sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="truncate">{selectedDiff?.path}</DialogTitle>
            <DialogDescription>Changes captured during the agent turn.</DialogDescription>
          </DialogHeader>
          {selectedDiff ? (
            <div className="max-h-[68vh] overflow-y-auto scrollbar-sleek">
              <NativeChatDiffView lines={selectedDiff.lines} />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function FileDiffRow({
  diff,
  onOpen
}: {
  diff: NativeChatFileDiff
  onOpen: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <Pencil className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate underline decoration-border underline-offset-2 group-hover:decoration-foreground/50">
        {diff.path}
      </span>
      <span className="ml-auto shrink-0 font-mono">
        <span className="text-muted-foreground group-hover:text-[var(--git-decoration-added)]">
          +{diff.additions}
        </span>{' '}
        <span className="text-muted-foreground group-hover:text-[var(--git-decoration-deleted)]">
          -{diff.deletions}
        </span>
      </span>
    </button>
  )
}

function ActivityToolRow({ tool }: { tool: RoomActivityToolStep }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const input = formatToolInput(tool.call.input)
  const output = tool.result?.output ?? ''
  const preview = briefToolArg(tool.call.input)
  const hasDetails = Boolean(input || output)
  return (
    <div>
      <button
        type="button"
        disabled={!hasDetails}
        aria-expanded={hasDetails ? expanded : undefined}
        onClick={() => hasDetails && setExpanded((current) => !current)}
        className="group flex w-full min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <ActivityKindIcon kind={tool.kind} />
        <span className="shrink-0 font-medium">{tool.call.name}</span>
        {preview ? <span className="min-w-0 truncate font-mono">{preview}</span> : null}
        {hasDetails ? (
          <ChevronRight
            className={cn(
              'ml-auto size-3.5 shrink-0 transition-transform',
              expanded && 'rotate-90'
            )}
          />
        ) : null}
      </button>
      {expanded ? <ToolDetails input={input} result={tool.result} /> : null}
    </div>
  )
}

function ToolDetails({
  input,
  result
}: {
  input: string
  result: NativeChatToolResultBlock | null
}): React.JSX.Element {
  return (
    <div className="ml-6 mt-1 max-h-56 space-y-1.5 overflow-y-auto rounded bg-accent/70 p-2 font-mono text-[11px] scrollbar-sleek">
      {input ? (
        <pre className="whitespace-pre-wrap break-words text-foreground/80">{clip(input)}</pre>
      ) : null}
      {result?.output ? (
        <pre
          className={cn(
            'whitespace-pre-wrap break-words border-t border-border/60 pt-1.5 text-foreground/70',
            result.isError && 'text-destructive'
          )}
        >
          {clip(result.output)}
        </pre>
      ) : null}
    </div>
  )
}

function toolGroupPrimaryKind(tools: RoomActivityToolStep[]): RoomActivityKind {
  for (const kind of ['editing', 'command', 'reading', 'searching', 'web'] as const) {
    if (tools.some((tool) => tool.kind === kind)) {
      return kind
    }
  }
  return 'working'
}

function toolGroupLabel(tools: RoomActivityToolStep[]): string {
  const has = (kind: RoomActivityKind): boolean => tools.some((tool) => tool.kind === kind)
  if (has('editing') && has('command')) {
    return 'Edited files and ran commands'
  }
  if (has('editing')) {
    return 'Edited files'
  }
  if (has('command')) {
    return 'Ran commands'
  }
  if (has('reading') && has('searching')) {
    return 'Read files and searched code'
  }
  if (has('reading')) {
    return 'Read files'
  }
  if (has('searching')) {
    return 'Searched code'
  }
  if (has('web')) {
    return 'Searched the web'
  }
  return 'Used tools'
}

export function ActivityKindIcon({ kind }: { kind: RoomActivityKind }): React.JSX.Element {
  const Icon =
    kind === 'editing'
      ? Pencil
      : kind === 'command'
        ? SquareTerminal
        : kind === 'reading'
          ? FileText
          : kind === 'searching'
            ? Search
            : kind === 'web'
              ? Globe2
              : FileText
  return <Icon className="size-3.5 shrink-0" />
}

function clip(value: string): string {
  return value.length > MAX_DETAIL_CHARS ? `${value.slice(0, MAX_DETAIL_CHARS)}…` : value
}
