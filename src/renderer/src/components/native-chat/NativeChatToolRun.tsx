import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { Fragment, useMemo } from 'react'
import { useNativeChatDisclosure } from './native-chat-disclosure-store'
import { NativeChatToolLine } from './NativeChatToolLine'
import { Check, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  isToolCallBlock,
  type NativeChatBlock,
  type NativeChatSubagentGroupBlock,
  type NativeChatToolCallBlock
} from '../../../../shared/native-chat-types'
import { isRenderableSubagentGroup } from '../../../../shared/native-chat-subagent-summary'
import { NativeChatDiffCard } from './NativeChatDiffCard'
import type { NativeChatDiffReveal } from './native-chat-turn-diffs'
import { buildEditCards, NO_EDIT_CARDS } from './native-chat-edit-cards'
import {
  countToolCalls,
  toolRunSummaryMembers,
  type ToolRunMember
} from './native-chat-tool-summary'
import {
  NATIVE_CHAT_TOOL_ACTIVITY_COPY,
  selectActiveToolCall
} from '../../../../shared/native-chat-tool-activity'
import { nativeChatToolRunIconName } from '../../../../shared/native-chat-tool-icon'
import { NativeChatTaskList } from './NativeChatTaskList'
import { buildNativeChatTaskListRows } from './native-chat-task-list-history'
import { NativeChatSubagentRun } from './NativeChatSubagentRun'
import { NativeChatToolIcon, NativeChatToolRunIcon } from './NativeChatToolIcon'
import { nativeChatToolActivityLabel } from './native-chat-tool-activity-label'

/** Stable empty default: a fresh array literal per render breaks memoization. */
const NO_SUBAGENT_GROUPS: NativeChatSubagentGroupBlock[] = []

/** A run of a message's tool calls/results, collapsed to a one-line summary that
 *  expands to the individual inline tool lines. */
export function NativeChatToolRun({
  blocks,
  previousTodoWrite,
  previousUpdatePlan,
  revealedDiff,
  onRevealDiff,
  subagentGroups = NO_SUBAGENT_GROUPS,
  expandSignal,
  activeTurnIsWorking,
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
  /** Legacy view-level default; production native-chat entry points pass false. */
  expandSignal: boolean
  /** Per-turn disclosure state controlled by the completed turn status row. */
  expandOverride?: boolean
  /** Structured lifecycle state, when available, keeps orphaned running calls from spinning. */
  activeTurnIsWorking?: boolean
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
  const callCount = countToolCalls(blocks) || blocks.length
  // Members stay separate all the way to the markup: joining them into one
  // string is what made a run read as a single call, because the separator also
  // occurs inside tool names like `browser.open` and `tools/read`.
  const summaryMembers = toolRunSummaryMembers(blocks)
  const hiddenCallCount = Math.max(0, callCount - summaryMembers.length)
  // Same content-signature keying the member rows below use: two identical calls
  // in one run are distinguished by occurrence, never by list position.
  const keyedSummaryMembers = ((): (ToolRunMember & { key: string })[] => {
    const seen = new Map<string, number>()
    return summaryMembers.map((member) => {
      const signature = `${member.name}:${member.arg}`
      const occurrence = seen.get(signature) ?? 0
      seen.set(signature, occurrence + 1)
      return { ...member, key: `${signature}:${occurrence}` }
    })
  })()
  const latestActiveCall = structuredActivityUi
    ? selectActiveToolCall(blocks, { activeTurnIsWorking })
    : null
  const isSettled = latestActiveCall == null
  const hasRunningCall = blocks.some((block) => isToolCallBlock(block) && block.state === 'running')
  // The turn caret opens the activity group while each child tool stays collapsed.
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
  // Only the settled header reads this. It stands over `summaryMembers`, which speaks
  // for the run's first calls rather than its last, so a glyph taken from one
  // call would assert a category the text beside it doesn't describe. A run that
  // spans categories therefore heads with the generic tool glyph. The glyph is
  // fixed once settled, so state rides on the trailing mark — a leading glyph
  // that flipped to a check would read as a change of identity.
  const settledHeaderIcon = nativeChatToolRunIconName(blocks.filter(isToolCallBlock))
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
    return subagentRows.length > 0 ? <div className="mt-3">{subagentRows}</div> : null
  }

  // Completed turn activity belongs behind the turn-status disclosure. Keeping
  // the grouped row visible here made a failed child command look like the
  // whole response was still running (or had failed) even while collapsed.
  if (
    structuredActivityUi &&
    expandOverride === false &&
    !(revealedDiff && open) &&
    isSettled &&
    activeTurnIsWorking === false
  ) {
    // The roster is not tool activity, so it survives this guard exactly as it
    // survives the tool-less escape above — otherwise a group sharing a message
    // with tool calls is dropped from every settled turn.
    return subagentRows.length > 0 ? <div className="mt-3">{subagentRows}</div> : null
  }

  return (
    // Extra top margin sets the tool run apart from the assistant prose above it
    // so the turn's activity doesn't crowd the message text.
    <div className="mt-3">
      {subagentRows}
      {latestActiveCall ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="group flex min-h-6 w-full items-center gap-1.5 rounded-md py-0.5 text-left text-sm leading-relaxed text-muted-foreground hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
          aria-expanded={open}
          aria-live="polite"
        >
          <NativeChatToolIcon
            mcpIdentity={latestActiveCall.mcpIdentity}
            rowWord={latestActiveCall.name}
            className="text-muted-foreground"
          />
          <span className="min-w-0 animate-pulse truncate text-foreground/85 motion-reduce:animate-none">
            {nativeChatToolActivityLabel(latestActiveCall)}
          </span>
          {open ? <ChevronRight className="size-3.5 rotate-90 text-muted-foreground" /> : null}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="group flex min-h-6 w-full items-center gap-1.5 py-0.5 text-left"
          aria-expanded={open}
        >
          {structuredActivityUi && settledHeaderIcon ? (
            <NativeChatToolRunIcon iconName={settledHeaderIcon} className="text-muted-foreground" />
          ) : null}
          <span className="shrink-0 font-mono text-[11px] font-bold text-muted-foreground transition-colors group-hover:text-foreground/80">
            {callCount}×
          </span>
          {summaryMembers.length > 0 ? (
            <>
              {/* Each member is led by its own category glyph, which is what marks
                  the boundary. A separator character cannot: `·` occurs inside
                  `browser.open` and `tools/read`. The list stays one line and
                  truncates as a whole rather than wrapping into a block — a
                  header that grows to three rows stops reading as a header. */}
              <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground transition-colors group-hover:text-foreground/80">
                {keyedSummaryMembers.map((member, index) => (
                  <Fragment key={member.key}>
                    {/* A real space, not just the margin: a CSS gap is invisible to
                        a copied selection and to the button's accessible name, which
                        would otherwise run one member's argument into the next
                        member's name. The margin is trimmed to pay for its width. */}
                    {index > 0 ? ' ' : null}
                    <span data-tool-run-member className={cn(index > 0 && 'ml-2')}>
                      <NativeChatToolIcon
                        rowWord={member.name}
                        mcpIdentity={member.mcpIdentity}
                        className="mr-1 inline-flex size-3.5 align-middle"
                      />
                      {member.name}
                      {member.arg ? (
                        <span className="text-muted-foreground/70">{` ${member.arg}`}</span>
                      ) : null}
                    </span>
                  </Fragment>
                ))}
              </span>
              {hiddenCallCount > 0 ? (
                /* Outside the truncating span, so the count of what is not shown
                   survives a list the pane is too narrow to print. */
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground transition-colors group-hover:text-foreground/80">
                  {translate(
                    'components.native-chat.tool.moreCalls',
                    NATIVE_CHAT_TOOL_ACTIVITY_COPY.moreCalls,
                    { value0: hiddenCallCount }
                  )}
                </span>
              ) : null}
            </>
          ) : (
            <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground transition-colors group-hover:text-foreground/80">
              {fallbackLabel}
            </span>
          )}
          {/* A running item cannot inherit completion from its turn. */}
          {structuredActivityUi && !hasRunningCall ? (
            <Check aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          ) : null}
          {/* Chevron is revealed on hover when collapsed and points down when open. */}
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-all',
              open ? 'rotate-90 opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
          />
        </button>
      )}
      {open ? (
        // Members are indented under the header because nothing else marks the
        // run's extent — flush rows are indistinguishable from the blocks after
        // them, so the batch has no visible end.
        <div className="mt-1 pl-4">
          {(() => {
            const seen = new Map<string, number>()
            return blocks.map((block, blockIndex) => {
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
              if (consumedResults.has(block)) {
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
              const lineIdentity =
                block.type === 'tool-call' && block.callId
                  ? `call:${block.callId}`
                  : `${signature}:${occurrence}`
              return (
                <NativeChatToolLine
                  key={lineIdentity}
                  block={block}
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
