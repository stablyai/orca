import type {
  NativeChatBlock,
  NativeChatToolCallBlock,
  NativeChatToolResultBlock
} from '../../../../../../shared/native-chat/native-chat-types'
import { pairNativeChatToolResults } from '../../../../../../shared/native-chat/tools/native-chat-tool-pairing'
import { nativeChatToolLineIdentity } from '../../../../../../shared/native-chat/tools/native-chat-tool-line-identity'
import { buildEditCards } from '../../../../../../shared/native-chat/tools/native-chat-edit-cards'
import type { NativeChatEditFile } from '../../../../../../shared/native-chat/tools/native-chat-edit-model'
import {
  buildNativeChatTaskListRows,
  type NativeChatTaskListRow
} from '../../../../../../shared/native-chat/input/native-chat-task-list-history'
import type { NativeChatToolRunAsides } from './NativeChatToolRun'

/** One drawn row of an opened run. `focusable`: it renders a control, so keyboard order can land on it. */
export type NativeChatToolRunRow =
  | { kind: 'aside'; key: string; focusable: boolean; element: React.JSX.Element }
  | { kind: 'tasks'; key: string; focusable: boolean; taskList: NativeChatTaskListRow }
  | {
      kind: 'edit'
      key: string
      focusable: true
      editKey: string
      files: NativeChatEditFile[]
    }
  | {
      kind: 'line'
      key: string
      focusable: true
      block: NativeChatBlock
      result: NativeChatToolResultBlock | undefined
      lineIdentity: string
    }

/** A thought with no words draws nothing, so keyboard order cannot land on it. */
function asideDrawsControl(element: React.JSX.Element): boolean {
  const props: unknown = element.props
  return !(
    typeof props === 'object' &&
    props !== null &&
    'markdown' in props &&
    typeof props.markdown === 'string' &&
    props.markdown.trim() === ''
  )
}

/** The run's rows in drawing order, with today's keys; pairing and grouping run once over the whole run. */
export function buildNativeChatToolRunRows({
  blocks,
  headerBlocks,
  asides,
  previousTodoWrite,
  previousUpdatePlan
}: {
  blocks: NativeChatBlock[]
  headerBlocks: NativeChatBlock[]
  asides?: NativeChatToolRunAsides
  previousTodoWrite?: NativeChatToolCallBlock
  previousUpdatePlan?: NativeChatToolCallBlock
}): NativeChatToolRunRow[] {
  const taskLists = buildNativeChatTaskListRows(blocks, {
    todowrite: previousTodoWrite,
    update_plan: previousUpdatePlan
  })
  const { editCards, consumedResults } = buildEditCards(blocks)
  const { resultByCall, pairedResults } = pairNativeChatToolResults(headerBlocks)
  const seen = new Map<string, number>()
  const rows: NativeChatToolRunRow[] = []
  const pushAsides = (elements: readonly React.JSX.Element[] | undefined): void => {
    for (const element of elements ?? []) {
      rows.push({
        kind: 'aside',
        key: String(element.key),
        focusable: asideDrawsControl(element),
        element
      })
    }
  }
  for (const [blockIndex, block] of headerBlocks.entries()) {
    pushAsides(asides?.before.get(block))
    const taskList = taskLists.rows.get(block)
    if (taskList) {
      // Only an update shows its "Full task list" trigger; a first list has no control.
      rows.push({
        kind: 'tasks',
        key: `tasks:${blockIndex}`,
        focusable: taskList.previous !== undefined,
        taskList
      })
      continue
    }
    if (taskLists.consumedResults.has(block)) {
      continue
    }
    const edit = editCards.get(block)
    if (edit) {
      rows.push({
        kind: 'edit',
        key: `edit:${edit.key}`,
        focusable: true,
        editKey: edit.key,
        files: edit.files
      })
      continue
    }
    // A result its call now owns is drawn by that call's line, not as a row of its own.
    if (consumedResults.has(block) || pairedResults.has(block)) {
      continue
    }
    const lineIdentity = nativeChatToolLineIdentity(block, seen)
    rows.push({
      kind: 'line',
      key: lineIdentity,
      focusable: true,
      block,
      result: block.type === 'tool-call' ? resultByCall.get(block) : undefined,
      lineIdentity
    })
  }
  pushAsides(asides?.after)
  return rows
}
