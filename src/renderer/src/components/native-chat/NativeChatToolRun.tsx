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
import { isRenderableSubagentGroup } from '../../../../shared/native-chat/transcript/native-chat-subagent-summary'
import type { NativeChatDiffReveal } from './native-chat-turn-diffs'
import { nativeChatToolRunSentence } from './native-chat-tool-run-label'
import { NATIVE_CHAT_TOOL_ACTIVITY_COPY } from '../../../../shared/native-chat/tools/native-chat-tool-activity'
import { nativeChatToolRunHeader } from '../../../../shared/native-chat/tools/native-chat-tool-run-header'
import { nativeChatAskRunSubject } from '../../../../shared/native-chat/input/native-chat-ask-row'
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
import { NativeChatBrowserRunPageButton } from './NativeChatBrowserPageButton'

/** Insert keyed asides before their block or after the final block. */
export type NativeChatToolRunAsides = {
  before: ReadonlyMap<NativeChatBlock, readonly React.JSX.Element[]>
  after: readonly React.JSX.Element[]
}

/** Stable empty default: a fresh array literal per render breaks memoization. */
const NO_SUBAGENT_GROUPS: NativeChatSubagentGroupBlock[] = []
const NO_BACKGROUND_TASKS: NativeChatBackgroundTaskBlock[] = []

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
  /** Only a working turn’s trailing run stays live; omitted means trailing for compatibility. */
  trailing?: boolean
  /** Remember disclosure by message id outside the windowed row’s lifetime. */
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
  // Key reader overrides by controlling disclosure state so returning restores them without mid-render store writes.
  const runKey =
    disclosureId === undefined
      ? undefined
      : `run:${disclosureId}:${expandSignal}:${revealedDiff?.requestId ?? '-'}`
  const { open, setOpen } = useNativeChatDisclosure(runKey, revealedDiff ? true : expandSignal)

  // Share the renderability predicate with slot selection so childless groups cannot create empty margin wrappers.
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
  // Roster/task rows bypass tool-header hiding because they carry durable state beyond the originating turn.
  const standaloneRows = [
    ...subagentRows,
    ...backgroundTasks.map((task) => <NativeChatBackgroundTaskRun key={task.taskId} block={task} />)
  ]
  const {
    asks,
    work: headerBlocks,
    askIsActive,
    live,
    callCount,
    fallbackLabel: fallbackKey,
    latestCallLabel,
    iconName: settledHeaderIcon,
    succeeded: runSucceeded,
    failedCallCount,
    interruptedCallCount
  } = useMemo(
    () => nativeChatToolRunHeader(blocks, { activeTurnIsWorking, trailing }),
    [activeTurnIsWorking, blocks, trailing]
  )
  const hasAskCall = asks.length > 0
  const askSubject = hasAskCall ? nativeChatAskRunSubject(asks) : null
  const showsHeader = !hasAskCall || callCount > 0
  // A single command is more recognizable than its category summary.
  const runSentence = nativeChatToolRunSentence(headerBlocks, { live })
  // The card sits inside the run's own scroll box, so that box has to move too.
  const revealDiff = useMemo(
    () =>
      onRevealDiff
        ? (card: HTMLElement) => onRevealDiff(revealNativeChatToolRunMember(card))
        : undefined,
    [onRevealDiff]
  )
  const fallbackLabel =
    fallbackKey === 'result'
      ? translate('components.native-chat.tool.result', NATIVE_CHAT_TOOL_ACTIVITY_COPY.result)
      : translate('components.native-chat.tool.callCount', '{{count}} tool calls', {
          count: callCount,
          defaultValue_one: '{{count}} tool call'
        })

  // Standalone rosters/tasks have no tool calls for a header to summarize.
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
        <div className="flex items-start gap-1">
          {/* Keep one header across live/settled states; summary line-height aligns marks and wrapped text. */}
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="group/tool-run flex min-h-6 min-w-0 flex-1 items-start gap-1.5 rounded-md py-0.5 text-left text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
                'min-w-0 line-clamp-2 whitespace-normal break-words text-sm leading-relaxed transition-colors',
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
            {/* Mark only stated success after settlement; idle gaps between live calls are not completion. */}
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
          <NativeChatBrowserRunPageButton calls={headerBlocks.filter(isToolCallBlock)} />
        </div>
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
