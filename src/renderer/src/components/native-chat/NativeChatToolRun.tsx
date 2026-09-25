import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { useMemo } from 'react'
import { useNativeChatDisclosure } from './native-chat-disclosure-store'
import { NativeChatToolLine } from './NativeChatToolLine'
import { Check, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  isToolCallBlock,
  type NativeChatBackgroundTaskBlock,
  type NativeChatBlock,
  type NativeChatSubagentGroupBlock,
  type NativeChatToolCallBlock
} from '../../../../shared/native-chat-types'
import { isRenderableSubagentGroup } from '../../../../shared/native-chat-subagent-summary'
import { NativeChatDiffCard } from './NativeChatDiffCard'
import type { NativeChatDiffReveal } from './native-chat-turn-diffs'
import { buildEditCards, NO_EDIT_CARDS } from './native-chat-edit-cards'
import { countToolCalls } from './native-chat-tool-summary'
import { nativeChatToolRunSentence } from './native-chat-tool-run-label'
import {
  NO_NATIVE_CHAT_TOOL_PAIRING,
  pairNativeChatToolResults
} from '../../../../shared/native-chat-tool-pairing'
import {
  describeLatestToolCall,
  NATIVE_CHAT_TOOL_ACTIVITY_COPY,
  selectActiveToolCall
} from '../../../../shared/native-chat-tool-activity'
import { nativeChatToolRunIconName } from '../../../../shared/native-chat-tool-icon'
import { nativeChatToolRunOutcome } from '../../../../shared/native-chat-tool-run-outcome'
import {
  nativeChatAskRunBlocks,
  nativeChatAskRunSubject
} from '../../../../shared/native-chat-ask-row'
import { NativeChatAwaitingInputRow } from './NativeChatAwaitingInputRow'
import { NativeChatTaskList } from './NativeChatTaskList'
import { buildNativeChatTaskListRows } from './native-chat-task-list-history'
import { NativeChatBackgroundTaskRun } from './NativeChatBackgroundTaskRun'
import { NativeChatSubagentRun } from './NativeChatSubagentRun'
import { NativeChatToolRunIcon } from './NativeChatToolIcon'

/** Stable empty default: a fresh array literal per render breaks memoization. */
const NO_SUBAGENT_GROUPS: NativeChatSubagentGroupBlock[] = []
const NO_BACKGROUND_TASKS: NativeChatBackgroundTaskBlock[] = []

/** A run of a message's tool calls/results, collapsed to a one-line summary that
 *  expands to the individual inline tool lines. */
export function NativeChatToolRun({
  blocks,
  previousTodoWrite,
  previousUpdatePlan,
  revealedDiff,
  onRevealDiff,
  subagentGroups = NO_SUBAGENT_GROUPS,
  backgroundTasks = NO_BACKGROUND_TASKS,
  expandSignal,
  activeTurnIsWorking,
  trailing,
  expandOverride,
  structuredActivityUi = true,
  disclosureId,
  onLinkClick
}: {
  blocks: NativeChatBlock[]
  previousTodoWrite?: NativeChatToolCallBlock
  previousUpdatePlan?: NativeChatToolCallBlock
  revealedDiff?: NativeChatDiffReveal
  onRevealDiff?: (element: HTMLElement) => void
  /** Spawn-group rosters that belong with this run's activity, one row each. */
  subagentGroups?: NativeChatSubagentGroupBlock[]
  /** Background tasks that belong with this run's activity, one row each. */
  backgroundTasks?: NativeChatBackgroundTaskBlock[]
  /** Legacy view-level default; production native-chat entry points pass false. */
  expandSignal: boolean
  /** Optional external control for callers that intentionally own this run's disclosure. */
  expandOverride?: boolean
  /** Structured lifecycle state, when available, keeps orphaned running calls from spinning. */
  activeTurnIsWorking?: boolean
  /** Whether this run is the working turn's last. Only that run is live: a run
   *  the agent has already moved past reads as settled even mid-call. Left
   *  unset, a working turn's run is taken to be its last. */
  trailing?: boolean
  structuredActivityUi?: boolean
  /** Message this run belongs to. Windowing unmounts rows, so a run the reader
   *  opened has to be remembered somewhere that outlives the row. */
  disclosureId?: string
  onLinkClick?: CommentMarkdownLinkClickHandler
}): React.JSX.Element | null {
  // A reader's deviation belongs to the controlling disclosure state, so returning
  // to that state restores the same choice without writing to the store mid-render.
  const runKey =
    disclosureId === undefined
      ? undefined
      : `run:${disclosureId}:${expandOverride ?? '-'}:${expandSignal}:${revealedDiff?.requestId ?? '-'}`
  const { open, setOpen } = useNativeChatDisclosure(
    runKey,
    revealedDiff ? true : (expandOverride ?? expandSignal)
  )

  // Childless groups are dropped so `subagentRows.length` stays an honest test of
  // "something will draw": the roster-only branch below returns a margin-bearing
  // wrapper on the strength of it, and a group with no children renders null.
  // Same predicate `subagentGroupBlocks` applies, so this row and the caller
  // deciding the row is worth mounting cannot disagree about what draws.
  const subagentRows = subagentGroups
    .filter(isRenderableSubagentGroup)
    .map((group) => <NativeChatSubagentRun key={group.groupId} block={group} />)
  // Neither a roster nor a background task is tool activity, so both take every
  // escape below that the tool header does not: a task row outlives the turn
  // that started it and is the only durable report of how it ended.
  const standaloneRows = [
    ...subagentRows,
    ...backgroundTasks.map((task) => <NativeChatBackgroundTaskRun key={task.taskId} block={task} />)
  ]
  const {
    asks,
    unansweredAsks,
    work: headerBlocks
  } = useMemo(() => nativeChatAskRunBlocks(blocks), [blocks])
  const hasAskCall = asks.length > 0
  const askSubject = hasAskCall ? nativeChatAskRunSubject(asks) : null
  const showsHeader = !hasAskCall || countToolCalls(headerBlocks) > 0
  const callCount = countToolCalls(headerBlocks) || headerBlocks.length
  const askIsActive = selectActiveToolCall(unansweredAsks, { activeTurnIsWorking }) !== null
  // Live is the turn's state, not a call's. Deriving it from "some call is
  // running" flipped the header to settled and back around every call, and a
  // call that finished inside a frame still bought the whole flip. The turn's
  // trailing run stays live from its first call until the agent moves on; a
  // caller with no turn state, or a turn blocked on the reader's answer, falls
  // back to the calls themselves.
  const live =
    structuredActivityUi &&
    (activeTurnIsWorking === true && !askIsActive
      ? trailing !== false
      : selectActiveToolCall(headerBlocks, { activeTurnIsWorking }) !== null)
  // One sentence for the whole run, or the command itself when the run is one
  // call — the reader recognizes `git push` faster than "Ran 1 command".
  const runSentence = nativeChatToolRunSentence(headerBlocks, { live })
  // What the run is doing now, beside the sentence: the latest call, running or
  // not, so a call that finished in a frame still leaves its name until the next.
  const latestCall = live ? headerBlocks.findLast(isToolCallBlock) : undefined
  const latestCallLabel = latestCall ? describeLatestToolCall(latestCall) : null
  const { succeeded: runSucceeded, failedCallCount } = nativeChatToolRunOutcome(headerBlocks, {
    activeTurnIsWorking
  })
  // An externally opened run keeps child tools collapsed; normal callers leave
  // the run's own disclosure independent from the turn status bar.
  const expandToolLines = expandOverride === undefined ? open : false
  // Diffing every edit is the run's most expensive work, so a collapsed run —
  // which renders none of it — never pays for it.
  const taskLists = useMemo(
    () =>
      open
        ? buildNativeChatTaskListRows(blocks, {
            todowrite: previousTodoWrite,
            update_plan: previousUpdatePlan
          })
        : null,
    [open, blocks, previousTodoWrite, previousUpdatePlan]
  )
  // Rollups cache counts only; detailed diff rows are built when the run opens.
  const { editCards, consumedResults } = useMemo(
    () => (open ? buildEditCards(blocks) : NO_EDIT_CARDS),
    [open, blocks]
  )
  const { resultByCall, pairedResults } = useMemo(
    () => (open ? pairNativeChatToolResults(headerBlocks) : NO_NATIVE_CHAT_TOOL_PAIRING),
    [open, headerBlocks]
  )
  // Only the settled header reads this. It stands over a sentence that speaks
  // for every call in the run, so a glyph taken from one of them would assert a
  // category the text beside it doesn't describe. A run that spans categories
  // therefore heads with the generic tool glyph. The glyph is fixed once
  // settled, so state rides on the trailing mark — a leading glyph that flipped
  // to a check would read as a change of identity.
  const settledHeaderIcon = nativeChatToolRunIconName(headerBlocks.filter(isToolCallBlock))
  const fallbackLabel =
    callCount === 1
      ? translate('components.native-chat.tool.countOne', NATIVE_CHAT_TOOL_ACTIVITY_COPY.countOne)
      : translate('components.native-chat.tool.countN', NATIVE_CHAT_TOOL_ACTIVITY_COPY.countN, {
          value0: callCount
        })

  // A roster with no tool calls beside it is the whole run: rendering the tool
  // header too would announce "1 tool call" for activity that has none.
  //
  // Ordered BEFORE the completed-turn guard below on purpose. That guard hides
  // TOOL activity behind the turn-status disclosure, and a roster row has none
  // to hide: it is the compact summary this row exists to leave behind. Bailing
  // there instead dropped it from every settled turn — the default state of the
  // whole transcript — and left the caller, which counts a spawn group as
  // renderable, drawing the empty bubble it explicitly guards against.
  if (blocks.length === 0) {
    return standaloneRows.length > 0 ? <div className="mt-3">{standaloneRows}</div> : null
  }

  // Completed turn activity belongs behind the turn-status disclosure. Keeping
  // the grouped row visible here made a failed child command look like the
  // whole response was still running (or had failed) even while collapsed.
  if (
    structuredActivityUi &&
    expandOverride === false &&
    !(revealedDiff && open) &&
    !live &&
    activeTurnIsWorking === false
  ) {
    // The roster is not tool activity, so it survives this guard exactly as it
    // survives the tool-less escape above — otherwise a group sharing a message
    // with tool calls is dropped from every settled turn.
    return standaloneRows.length > 0 ? <div className="mt-3">{standaloneRows}</div> : null
  }

  return (
    // Extra top margin sets the tool run apart from the assistant prose above it
    // so the turn's activity doesn't crowd the message text.
    <div className="mt-3">
      {standaloneRows}
      {hasAskCall ? (
        <NativeChatAwaitingInputRow
          subject={askSubject}
          pending={askIsActive}
          disclosureKey={disclosureId === undefined ? undefined : `ask:${disclosureId}`}
        />
      ) : null}
      {!showsHeader ? null : (
        // One element for the run's whole life. Live and settled are states of
        // this button, not two buttons: a header that remounted as a call started
        // and again as it ended lost its hover, its mark, and its count each time.
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="group/tool-run flex min-h-6 w-full items-center gap-1.5 rounded-md py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
          aria-expanded={open}
          aria-live="polite"
          data-native-chat-tool-run-state={live ? 'live' : 'settled'}
        >
          {structuredActivityUi && settledHeaderIcon ? (
            <NativeChatToolRunIcon iconName={settledHeaderIcon} className="text-muted-foreground" />
          ) : null}
          {/* The run in words, in the transcript's own type. Present tense while
              live, past once settled; the text changes in place and nothing
              around it moves. While live it keeps its width and the preview
              beside it is what gives way. */}
          <span
            className={cn(
              'truncate text-sm leading-relaxed transition-colors',
              live
                ? 'max-w-[72%] shrink-0 animate-pulse text-foreground/85 motion-reduce:animate-none'
                : 'min-w-0 text-muted-foreground group-hover/tool-run:text-foreground/80'
            )}
          >
            {runSentence ?? fallbackLabel}
          </span>
          {failedCallCount > 0 ? (
            /* Outside the truncating member list, so the one thing the reader
               cannot afford to miss survives a pane too narrow to print it.
               Quiet text in the header's own type, not a destructive tint or a
               swapped glyph: a tool error is routine work, and the failing
               line's own detail is one click away. */
            <span
              aria-label={translate(
                'components.native-chat.tool.failedCallsLabel',
                NATIVE_CHAT_TOOL_ACTIVITY_COPY.failedCallsLabel,
                { value0: failedCallCount }
              )}
              className="shrink-0 font-mono text-[11px] text-muted-foreground transition-colors group-hover/tool-run:text-foreground/80"
            >
              {translate(
                'components.native-chat.tool.failedCount',
                NATIVE_CHAT_TOOL_ACTIVITY_COPY.failedCount,
                { value0: failedCallCount }
              )}
            </span>
          ) : null}
          {/* Only a stated success is marked done — see nativeChatToolRunOutcome —
              and never while live: between two calls nothing is running, and a
              mark that appeared then would flash on every call. */}
          {structuredActivityUi && !live && runSucceeded ? (
            <Check aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          ) : null}
          {latestCallLabel ? (
            <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
              {latestCallLabel}
            </span>
          ) : null}
          {/* Revealed on hover of this header alone — see NativeChatToolLine on
              why the group is named — and points down when open. */}
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-all',
              open ? 'rotate-90 opacity-100' : 'opacity-0 group-hover/tool-run:opacity-100'
            )}
          />
        </button>
      )}
      {open && showsHeader ? (
        // Members are indented under the header because nothing else marks the
        // run's extent — flush rows are indistinguishable from the blocks after
        // them, so the batch has no visible end.
        <div className="mt-1 pl-4">
          {(() => {
            const seen = new Map<string, number>()
            return headerBlocks.map((block, blockIndex) => {
              const taskList = taskLists?.rows.get(block)
              if (taskList) {
                return <NativeChatTaskList key={`tasks:${blockIndex}`} {...taskList} />
              }
              if (taskLists?.consumedResults.has(block)) {
                return null
              }
              const edit = editCards.get(block)
              if (edit) {
                return (
                  <div key={`edit:${edit.key}`}>
                    {edit.files.map((file, fileIndex) => (
                      <NativeChatDiffCard
                        key={`${edit.key}:${fileIndex}`}
                        file={file}
                        revealSignal={
                          revealedDiff?.editKey === edit.key && revealedDiff.fileIndex === fileIndex
                            ? revealedDiff.requestId
                            : undefined
                        }
                        onReveal={onRevealDiff}
                        initiallyExpanded={expandToolLines}
                        disclosureKey={
                          disclosureId === undefined
                            ? undefined
                            : `diff:${disclosureId}:${edit.key}:${fileIndex}`
                        }
                      />
                    ))}
                  </div>
                )
              }
              // A result its call now owns is drawn by that call's line, not as
              // a row of its own.
              if (consumedResults.has(block) || pairedResults.has(block)) {
                return null
              }
              const signature =
                block.type === 'tool-call'
                  ? `${block.type}:${block.name}:${JSON.stringify(block.input)}`
                  : block.type === 'tool-result'
                    ? `${block.type}:${block.output}`
                    : `${block.type}`
              const occurrence = seen.get(signature) ?? 0
              seen.set(signature, occurrence + 1)
              const providerCallId =
                block.type === 'tool-call' &&
                block.callId !== undefined &&
                block.callId.trim().length > 0
                  ? block.callId
                  : undefined
              const lineIdentity =
                providerCallId !== undefined
                  ? `call:${providerCallId}`
                  : `${signature}:${occurrence}`
              return (
                <NativeChatToolLine
                  key={lineIdentity}
                  block={block}
                  result={block.type === 'tool-call' ? resultByCall.get(block) : undefined}
                  onLinkClick={onLinkClick}
                  initiallyExpanded={expandToolLines}
                  disclosureKey={
                    disclosureId === undefined ? undefined : `line:${disclosureId}:${lineIdentity}`
                  }
                />
              )
            })
          })()}
        </div>
      ) : null}
    </div>
  )
}
