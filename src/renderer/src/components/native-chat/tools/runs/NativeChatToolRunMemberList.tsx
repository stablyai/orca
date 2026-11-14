import { useCallback, useMemo } from 'react'
import type {
  NativeChatBlock,
  NativeChatToolCallBlock
} from '../../../../../../shared/native-chat/native-chat-types'
import { NativeChatDiffCard } from '../diffs/NativeChatDiffCard'
import { NativeChatTaskList } from '../tasks/NativeChatTaskList'
import { NativeChatToolLine } from '../lines/NativeChatToolLine'
import type { NativeChatDiffReveal } from '../../../../../../shared/native-chat/tools/native-chat-turn-diffs'
import type { NativeChatToolRunAsides } from './NativeChatToolRun'
import { buildNativeChatToolRunRows, type NativeChatToolRunRow } from './native-chat-tool-run-rows'
import { NativeChatToolRunMembers } from './NativeChatToolRunMembers'

/** Mount only while expanded so collapsed runs avoid member pairing and diff work. */
export function NativeChatToolRunMemberList({
  blocks,
  headerBlocks,
  previousTodoWrite,
  previousUpdatePlan,
  revealedDiff,
  onRevealDiff,
  disclosureId,
  asides,
  followKey,
  startsAtEnd,
  memoryKey
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
  followKey: number
  startsAtEnd: boolean
  memoryKey?: string
}): React.JSX.Element {
  // One flat keyed row list with or without asides, so a row gaining its first never remounts a line.
  const rows = useMemo(
    () =>
      buildNativeChatToolRunRows({
        blocks,
        headerBlocks,
        asides,
        previousTodoWrite,
        previousUpdatePlan
      }),
    [asides, blocks, headerBlocks, previousTodoWrite, previousUpdatePlan]
  )

  const renderRow = useCallback(
    (row: NativeChatToolRunRow): React.ReactNode => {
      switch (row.kind) {
        case 'aside':
          return row.element
        case 'tasks':
          return (
            <NativeChatTaskList
              {...row.taskList}
              disclosureKey={
                disclosureId === undefined ? undefined : `tasks:${disclosureId}:${row.key}`
              }
            />
          )
        case 'edit':
          return row.files.map((file, fileIndex) => (
            <NativeChatDiffCard
              key={`${row.editKey}:${fileIndex}`}
              file={file}
              revealSignal={
                revealedDiff?.editKey === row.editKey && revealedDiff.fileIndex === fileIndex
                  ? revealedDiff.requestId
                  : undefined
              }
              onReveal={onRevealDiff}
              disclosureKey={
                disclosureId === undefined
                  ? undefined
                  : `diff:${disclosureId}:${row.editKey}:${fileIndex}`
              }
            />
          ))
        case 'line':
          return (
            <NativeChatToolLine
              block={row.block}
              result={row.result}
              disclosureKey={
                disclosureId === undefined ? undefined : `line:${disclosureId}:${row.lineIdentity}`
              }
            />
          )
      }
    },
    [disclosureId, onRevealDiff, revealedDiff]
  )

  return (
    <NativeChatToolRunMembers
      rows={rows}
      renderRow={renderRow}
      followKey={followKey}
      startsAtEnd={startsAtEnd}
      memoryKey={memoryKey}
      revealRowKey={revealedDiff ? `edit:${revealedDiff.editKey}` : undefined}
    />
  )
}
