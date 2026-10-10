import { useMemo } from 'react'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import type { NativeChatBlock, NativeChatToolCallBlock } from '../../../../shared/native-chat-types'
import { pairNativeChatToolResults } from '../../../../shared/native-chat-tool-pairing'
import { NativeChatDiffCard } from './NativeChatDiffCard'
import { NativeChatTaskList } from './NativeChatTaskList'
import { NativeChatToolLine } from './NativeChatToolLine'
import { buildEditCards } from './native-chat-edit-cards'
import { buildNativeChatTaskListRows } from './native-chat-task-list-history'
import type { NativeChatDiffReveal } from './native-chat-turn-diffs'
import type { NativeChatToolRunAsides } from './NativeChatToolRun'

/** A row's identity when its provider gave none: what it says, and which repeat of that it is. */
function contentIdentity(block: NativeChatBlock, seen: Map<string, number>): string {
  const signature =
    block.type === 'tool-call'
      ? `${block.type}:${block.name}:${JSON.stringify(block.input)}`
      : block.type === 'tool-result'
        ? `${block.type}:${block.output}`
        : `${block.type}`
  const occurrence = seen.get(signature) ?? 0
  seen.set(signature, occurrence + 1)
  return `${signature}:${occurrence}`
}

/** An opened run's members in order, each one line until opened. Mounted only while the
 *  run is open, so a collapsed run pays for none of the diffing and pairing done here. */
export function NativeChatToolRunMemberList({
  blocks,
  headerBlocks,
  previousTodoWrite,
  previousUpdatePlan,
  revealedDiff,
  onRevealDiff,
  disclosureId,
  onLinkClick,
  asides
}: {
  /** Every tool block of the run; `headerBlocks` is those minus its asks. */
  blocks: NativeChatBlock[]
  headerBlocks: NativeChatBlock[]
  /** Rows the transcript draws among the calls, such as the thoughts between them. */
  asides?: NativeChatToolRunAsides
  previousTodoWrite?: NativeChatToolCallBlock
  previousUpdatePlan?: NativeChatToolCallBlock
  revealedDiff?: NativeChatDiffReveal
  onRevealDiff?: (element: HTMLElement) => void
  disclosureId?: string
  onLinkClick?: CommentMarkdownLinkClickHandler
}): React.JSX.Element {
  const taskLists = useMemo(
    () =>
      buildNativeChatTaskListRows(blocks, {
        todowrite: previousTodoWrite,
        update_plan: previousUpdatePlan
      }),
    [blocks, previousTodoWrite, previousUpdatePlan]
  )
  const { editCards, consumedResults } = useMemo(() => buildEditCards(blocks), [blocks])
  const { resultByCall, pairedResults } = useMemo(
    () => pairNativeChatToolResults(headerBlocks),
    [headerBlocks]
  )

  const seen = new Map<string, number>()
  const member = (block: NativeChatBlock, blockIndex: number): React.ReactNode => {
    const taskList = taskLists.rows.get(block)
    if (taskList) {
      return <NativeChatTaskList key={`tasks:${blockIndex}`} {...taskList} />
    }
    if (taskLists.consumedResults.has(block)) {
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
              onLinkClick={onLinkClick}
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
    // A result its call now owns is drawn by that call's line, not as a row of its own.
    if (consumedResults.has(block) || pairedResults.has(block)) {
      return null
    }
    const providerCallId =
      block.type === 'tool-call' && block.callId !== undefined && block.callId.trim().length > 0
        ? block.callId
        : undefined
    const lineIdentity =
      providerCallId !== undefined ? `call:${providerCallId}` : contentIdentity(block, seen)
    return (
      <NativeChatToolLine
        key={lineIdentity}
        block={block}
        result={block.type === 'tool-call' ? resultByCall.get(block) : undefined}
        onLinkClick={onLinkClick}
        disclosureKey={
          disclosureId === undefined ? undefined : `line:${disclosureId}:${lineIdentity}`
        }
      />
    )
  }

  // One flat keyed list with or without asides, so a row gaining its first never remounts a line.
  return (
    <>
      {headerBlocks.flatMap((block, blockIndex) => [
        ...(asides?.before.get(block) ?? []),
        member(block, blockIndex)
      ])}
      {asides?.after}
    </>
  )
}
