import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { NativeChatExpandable } from './NativeChatExpandable'
import { useNativeChatDisclosure } from './native-chat-disclosure-store'
import { Check } from 'lucide-react'
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
import type { NativeChatDiffReveal } from './native-chat-turn-diffs'
import { countToolCalls } from './native-chat-tool-summary'
import { nativeChatToolRunSentence } from './native-chat-tool-run-label'
import {
  describeLatestToolCall,
  NATIVE_CHAT_TOOL_ACTIVITY_COPY,
  selectActiveToolCall
} from '../../../../shared/native-chat-tool-activity'
import { nativeChatToolRunIconName } from './native-chat-tool-category'
import { nativeChatToolRunOutcome } from '../../../../shared/native-chat-tool-run-outcome'
import {
  nativeChatAskRunBlocks,
  nativeChatAskRunSubject
} from '../../../../shared/native-chat-ask-row'
import { NativeChatAwaitingInputRow } from './NativeChatAwaitingInputRow'
import { NativeChatBackgroundTaskRun } from './NativeChatBackgroundTaskRun'
import { NativeChatSubagentRun } from './NativeChatSubagentRun'
import type {
  NativeChatSubagentDisclosure,
  NativeChatSubagentRosterState
} from './native-chat-subagent-sections'
import { NativeChatToolRunIcon } from './NativeChatToolIcon'
import { NativeChatToolRunCallCounts } from './NativeChatToolRunCallCounts'
import { NativeChatToolRunMembers, revealNativeChatToolRunMember } from './NativeChatToolRunMembers'
import { NativeChatToolRunMemberList } from './NativeChatToolRunMemberList'

/** Rows drawn among an open run's lines, each keyed: before the block they are keyed by, or
 *  after the last. */
export type NativeChatToolRunAsides = {
  before: ReadonlyMap<NativeChatBlock, readonly React.JSX.Element[]>
  after: readonly React.JSX.Element[]
}

/** Stable empty default: a fresh array literal per render breaks memoization. */
const NO_SUBAGENT_GROUPS: NativeChatSubagentGroupBlock[] = []
const NO_BACKGROUND_TASKS: NativeChatBackgroundTaskBlock[] = []

/** A run of tool calls/results with a summary that expands to the individual tool lines. */
export function NativeChatToolRun({
  blocks,
  previousTodoWrite,
  previousUpdatePlan,
  revealedDiff,
  onRevealDiff,
  subagentGroups = NO_SUBAGENT_GROUPS,
  subagentRoster,
  subagentDisclosure,
  backgroundTasks = NO_BACKGROUND_TASKS,
  followsProse = true,
  expandSignal,
  activeTurnIsWorking,
  trailing,
  disclosureId,
  onLinkClick,
  asides
}: {
  blocks: NativeChatBlock[]
  previousTodoWrite?: NativeChatToolCallBlock
  previousUpdatePlan?: NativeChatToolCallBlock
  revealedDiff?: NativeChatDiffReveal
  onRevealDiff?: (element: HTMLElement) => void
  /** Spawn-group rosters that belong with this run's activity, one row each. */
  subagentGroups?: NativeChatSubagentGroupBlock[]
  /** The rosters' list state, and their children whose rows open below this run. */
  subagentRoster?: NativeChatSubagentRosterState
  subagentDisclosure?: NativeChatSubagentDisclosure
  /** Background tasks that belong with this run's activity, one row each. */
  backgroundTasks?: NativeChatBackgroundTaskBlock[]
  /** The row draws prose above this run, which the run then sits just under. */
  followsProse?: boolean
  /** Legacy view-level default; production native-chat entry points pass false. */
  expandSignal: boolean
  /** Structured lifecycle state, when available, keeps orphaned running calls from spinning. */
  activeTurnIsWorking?: boolean
  /** Whether this run is the working turn's last. Only that run is live: a run
   *  the agent has already moved past reads as settled even mid-call. Left
   *  unset, a working turn's run is taken to be its last. */
  trailing?: boolean
  /** Message this run belongs to. Windowing unmounts rows, so a run the reader
   *  opened has to be remembered somewhere that outlives the row. */
  disclosureId?: string
  onLinkClick?: CommentMarkdownLinkClickHandler
  asides?: NativeChatToolRunAsides
}): React.JSX.Element | null {
  // This row owns the language subscription for its tool, diff, and task labels.
  useTranslation()
  const spacing = followsProse ? 'mt-2' : undefined
  // Rows drawn among the calls count as work too: a reader at the end follows them arriving.
  const asideCount = useMemo(
    () =>
      asides
        ? asides.after.length +
          Array.from(asides.before.values()).reduce((count, rows) => count + rows.length, 0)
        : 0,
    [asides]
  )
  // A reader's deviation belongs to the controlling disclosure state, so returning
  // to that state restores the same choice without writing to the store mid-render.
  const runKey =
    disclosureId === undefined
      ? undefined
      : `run:${disclosureId}:${expandSignal}:${revealedDiff?.requestId ?? '-'}`
  const { open, setOpen } = useNativeChatDisclosure(runKey, revealedDiff ? true : expandSignal)

  // Childless groups are dropped so `subagentRows.length` stays an honest test of
  // "something will draw": the roster-only branch below returns a margin-bearing
  // wrapper on the strength of it, and a group with no children renders null.
  // Same predicate `subagentGroupBlocks` applies, so this row and the caller
  // deciding the row is worth mounting cannot disagree about what draws.
  const subagentRows = subagentGroups
    .filter(isRenderableSubagentGroup)
    .map((group) => (
      <NativeChatSubagentRun
        key={group.groupId}
        block={group}
        open={subagentRoster?.open}
        onSetOpen={
          subagentRoster && subagentDisclosure && disclosureId !== undefined
            ? (open) => subagentDisclosure.setRosterOpen(disclosureId, open)
            : undefined
        }
        sections={subagentRoster?.sections}
        onSetSectionOpen={subagentDisclosure?.setSectionOpen}
      />
    ))
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
  const callCount = countToolCalls(headerBlocks)
  const showsHeader = !hasAskCall || callCount > 0
  const askIsActive = selectActiveToolCall(unansweredAsks, { activeTurnIsWorking }) !== null
  // Live is the turn's state, not a call's. Deriving it from "some call is
  // running" flipped the header to settled and back around every call, and a
  // call that finished inside a frame still bought the whole flip. The turn's
  // trailing run stays live from its first call until the agent moves on; a
  // caller with no turn state, or a turn blocked on the reader's answer, falls
  // back to the calls themselves.
  const live =
    activeTurnIsWorking === true && !askIsActive
      ? trailing !== false
      : selectActiveToolCall(headerBlocks, { activeTurnIsWorking }) !== null
  // One sentence for the whole run, or the command itself when the run is one
  // call — the reader recognizes `git push` faster than "Ran 1 command".
  const runSentence = nativeChatToolRunSentence(headerBlocks, { live })
  // What the run is doing now, beside the sentence: the latest call, running or
  // not, so a call that finished in a frame still leaves its name until the next.
  const latestCall = live ? headerBlocks.findLast(isToolCallBlock) : undefined
  const latestCallLabel = latestCall ? describeLatestToolCall(latestCall) : null
  const {
    succeeded: runSucceeded,
    failedCallCount,
    interruptedCallCount
  } = nativeChatToolRunOutcome(headerBlocks, { activeTurnIsWorking })
  // The card sits inside the run's own scroll box, so that box has to move too.
  const revealDiff = useMemo(
    () =>
      onRevealDiff
        ? (card: HTMLElement) => onRevealDiff(revealNativeChatToolRunMember(card))
        : undefined,
    [onRevealDiff]
  )
  // Only the settled header reads this. It stands over a sentence that speaks
  // for every call in the run, so a glyph taken from one of them would assert a
  // category the text beside it doesn't describe. A run that spans categories
  // therefore heads with the generic tool glyph. The glyph is fixed once
  // settled, so state rides on the trailing mark — a leading glyph that flipped
  // to a check would read as a change of identity.
  const settledHeaderIcon = nativeChatToolRunIconName(headerBlocks.filter(isToolCallBlock))
  const fallbackLabel =
    callCount === 0
      ? translate('components.native-chat.tool.result', 'Result')
      : callCount === 1
        ? translate('components.native-chat.tool.countOne', NATIVE_CHAT_TOOL_ACTIVITY_COPY.countOne)
        : translate('components.native-chat.tool.countN', NATIVE_CHAT_TOOL_ACTIVITY_COPY.countN, {
            value0: callCount
          })

  // A roster with no tool calls beside it is the whole run: rendering the tool
  // header too would announce "1 tool call" for activity that has none.
  if (blocks.length === 0) {
    return standaloneRows.length > 0 ? <div className={spacing}>{standaloneRows}</div> : null
  }

  return (
    <div className={spacing}>
      {standaloneRows}
      {hasAskCall ? (
        <NativeChatAwaitingInputRow
          subject={askSubject}
          pending={askIsActive}
          disclosureKey={disclosureId === undefined ? undefined : `ask:${disclosureId}`}
          // A grouped ask here still names only its count.
          listsQuestions={false}
        />
      ) : null}
      {!showsHeader ? null : (
        // One element for the run's whole life. Live and settled are states of
        // this button, not two buttons: a header that remounted as a call started
        // and again as it ended lost its hover, its mark, and its count each time.
        // It carries the summary's type so each `h-[1lh]` slot is one summary line
        // tall: marks sit on line 1 and a wrapped line 2 starts under the text.
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="group/tool-run flex min-h-6 w-full items-start gap-1.5 rounded-md py-0.5 text-left text-sm native-chat-message-text leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
          aria-expanded={open}
          aria-live="polite"
          data-native-chat-tool-run-state={live ? 'live' : 'settled'}
        >
          {settledHeaderIcon ? (
            <span className="flex h-[1lh] shrink-0 items-center">
              <NativeChatToolRunIcon
                iconName={settledHeaderIcon}
                className="text-chat-foreground-faint"
              />
            </span>
          ) : null}
          {/* Keep the collapsed header bounded; the tool detail carries the full command. */}
          <span
            className={cn(
              'min-w-0 line-clamp-2 whitespace-normal break-words text-sm native-chat-message-text leading-relaxed transition-colors',
              live
                ? 'max-w-[72%] shrink-0 animate-pulse text-chat-foreground motion-reduce:animate-none'
                : 'min-w-0 text-chat-foreground-faint group-hover/tool-run:text-chat-foreground'
            )}
          >
            {runSentence ?? fallbackLabel}
          </span>
          <NativeChatToolRunCallCounts
            failed={failedCallCount}
            interrupted={interruptedCallCount}
          />
          {/* Only a stated success is marked done — see nativeChatToolRunOutcome —
              and never while live: between two calls nothing is running, and a
              mark that appeared then would flash on every call. */}
          {!live && runSucceeded ? (
            <span className="flex h-[1lh] shrink-0 items-center">
              <Check aria-hidden className="size-3 shrink-0 text-chat-foreground-faint" />
            </span>
          ) : null}
          {latestCallLabel ? (
            <span className="flex h-[1lh] min-w-0 items-center">
              <span className="min-w-0 truncate font-sans text-xs text-chat-foreground-faint">
                {latestCallLabel}
              </span>
            </span>
          ) : null}
        </button>
      )}
      <NativeChatExpandable open={open && showsHeader}>
        <NativeChatToolRunMembers
          followKey={blocks.length + asideCount}
          startsAtEnd={live && !revealedDiff}
          memoryKey={runKey}
        >
          <NativeChatToolRunMemberList
            blocks={blocks}
            headerBlocks={headerBlocks}
            asides={asides}
            previousTodoWrite={previousTodoWrite}
            previousUpdatePlan={previousUpdatePlan}
            revealedDiff={revealedDiff}
            onRevealDiff={revealDiff}
            disclosureId={disclosureId}
            onLinkClick={onLinkClick}
          />
        </NativeChatToolRunMembers>
      </NativeChatExpandable>
    </div>
  )
}
