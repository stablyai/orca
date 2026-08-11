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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { NativeChatFileDiff } from '../native-chat/native-chat-diff'
import { fileDiffsFromToolCall } from '../native-chat/native-chat-diff'
import { NativeChatDiffView } from '../native-chat/NativeChatDiffView'
import { briefToolArg, formatToolInput } from '../../../../shared/native-chat-tool-summary'
import { isSubagentToolName, nativeChatToolLabel } from '../../../../shared/native-chat-tool-name'
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
    <Collapsible open={expanded} onOpenChange={setExpanded} disabled={!hasDetails}>
      <div className="mb-2 border-b border-border/60 pb-2">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            disabled={!hasDetails}
            aria-expanded={hasDetails ? expanded : undefined}
            className={cn(
              'group flex items-center gap-1.5 text-xs text-muted-foreground',
              hasDetails && 'hover:text-foreground'
            )}
          >
            <span>
              {translate('rooms.activity.workedFor', 'Worked for {{duration}}', {
                duration: formatRoomActivityDuration(activity.startedAt, activity.completedAt)
              })}
            </span>
            {hasDetails ? (
              <ChevronRight
                className={cn(
                  'size-3.5 transition-transform duration-200 ease motion-reduce:transition-none',
                  expanded && 'rotate-90'
                )}
              />
            ) : null}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="room-activity-disclosure-content">
          <RoomActivityDetails messages={activity.messages} />
        </CollapsibleContent>
      </div>
    </Collapsible>
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
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-expanded={expanded}
            className="group flex w-full items-center gap-2 text-left text-muted-foreground hover:text-foreground"
          >
            <ActivityKindIcon kind={primaryKind} />
            <span>{toolGroupLabel(tools)}</span>
            <ChevronRight
              className={cn(
                'size-3.5 shrink-0 transition-transform duration-200 ease motion-reduce:transition-none',
                expanded && 'rotate-90'
              )}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="room-activity-disclosure-content">
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
        </CollapsibleContent>
        <Dialog
          open={selectedDiff !== null}
          onOpenChange={(open) => !open && setSelectedDiff(null)}
        >
          <DialogContent
            data-room-activity-stack-portal
            className="max-h-[85vh] min-w-0 sm:max-w-4xl"
          >
            <DialogHeader>
              <DialogTitle className="truncate">{selectedDiff?.path}</DialogTitle>
              <DialogDescription>
                {translate(
                  'rooms.activity.changesCaptured',
                  'Changes captured during the agent turn.'
                )}
              </DialogDescription>
            </DialogHeader>
            {selectedDiff ? (
              <div className="max-h-[68vh] overflow-y-auto scrollbar-sleek">
                <NativeChatDiffView lines={selectedDiff.lines} />
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
      </div>
    </Collapsible>
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
  const coordination = isSubagentToolName(tool.call.name)
  const input = coordination ? '' : formatToolInput(tool.call.input)
  const output = coordination ? '' : (tool.result?.output ?? '')
  const preview = coordination ? '' : briefToolArg(tool.call.input)
  const hasDetails = Boolean(input || output)
  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} disabled={!hasDetails}>
      <div>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            disabled={!hasDetails}
            aria-expanded={hasDetails ? expanded : undefined}
            className="group flex w-full min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ActivityKindIcon kind={tool.kind} />
            <span className="shrink-0 font-medium">{nativeChatToolLabel(tool.call.name)}</span>
            {preview ? <span className="min-w-0 truncate font-mono">{preview}</span> : null}
            {hasDetails ? (
              <ChevronRight
                className={cn(
                  'ml-auto size-3.5 shrink-0 transition-transform duration-200 ease motion-reduce:transition-none',
                  expanded && 'rotate-90'
                )}
              />
            ) : null}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="room-activity-disclosure-content">
          <ToolDetails input={input} result={tool.result} />
        </CollapsibleContent>
      </div>
    </Collapsible>
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
  if (tools.every((tool) => isSubagentToolName(tool.call.name))) {
    return translate('rooms.activity.coordinatedSubagents', 'Coordinated subagents')
  }
  const has = (kind: RoomActivityKind): boolean => tools.some((tool) => tool.kind === kind)
  if (has('editing') && has('command')) {
    return translate('rooms.activity.editedFilesAndRanCommands', 'Edited files and ran commands')
  }
  if (has('editing')) {
    return translate('rooms.activity.editedFiles', 'Edited files')
  }
  if (has('command')) {
    return translate('rooms.activity.ranCommands', 'Ran commands')
  }
  if (has('reading') && has('searching')) {
    return translate('rooms.activity.readFilesAndSearchedCode', 'Read files and searched code')
  }
  if (has('reading')) {
    return translate('rooms.activity.readFiles', 'Read files')
  }
  if (has('searching')) {
    return translate('rooms.activity.searchedCode', 'Searched code')
  }
  if (has('web')) {
    return translate('rooms.activity.searchedWeb', 'Searched the web')
  }
  return translate('rooms.activity.usedTools', 'Used tools')
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
