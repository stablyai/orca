// Latest task list, read from the transcript both clients already have.
// A snapshot replaces the list. Grok merges todo_write by id. Claude's Task* tools edit one row.

import type { NativeChatMessage } from '../native-chat-types'
import { CODEX_PLAN_UPDATED_FRAME_KIND } from '../native-chat-provider-frame-summary'
import { pairToolBlocks } from '../tools/native-chat-tool-pairs'
import {
  applyNativeChatTaskListCall,
  normalizeNativeChatTaskList,
  readNativeChatTaskListCall,
  type NativeChatTask,
  type NativeChatTaskList,
  type NativeChatTaskStatus
} from './native-chat-task-list'
import {
  createNativeChatTaskBook,
  type NativeChatTaskBook,
  type NativeChatTaskSeedList
} from './native-chat-claude-task-updates'

const PLAN_CHECKBOX = /^- \[([ xX~-])\] (.*)$/
const PLAN_BULLET = /^(?:[-*]|\d+[.)])\s+(.+)$/

/** Checkbox lines the ACP plan update writes. A plan with no boxes uses its list items as pending tasks. */
export function nativeChatTaskListFromPlanDocument(text: string): NativeChatTaskList | null {
  const boxes: NativeChatTask[] = []
  const bullets: NativeChatTask[] = []
  let sawBox = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    const box = PLAN_CHECKBOX.exec(trimmed)
    if (box) {
      sawBox = true
      const content = box[2]?.trim()
      if (content) {
        boxes.push({ content, status: checkboxStatus(box[1]) })
      }
      continue
    }
    if (sawBox) {
      continue
    }
    const content = PLAN_BULLET.exec(trimmed)?.[1]?.trim()
    if (content) {
      bullets.push({ content, status: 'pending' })
    }
  }
  if (sawBox) {
    return { tasks: boxes }
  }
  return bullets.length > 0 ? { tasks: bullets } : null
}

function checkboxStatus(mark: string | undefined): NativeChatTaskStatus {
  if (mark === 'x' || mark === 'X') {
    return 'completed'
  }
  if (mark === '~') {
    return 'in_progress'
  }
  if (mark === '-') {
    return 'cancelled'
  }
  return 'pending'
}

/** The list as of the last accepted update. A seed is the history outside this window. */
export function latestNativeChatTaskList(
  messages: readonly NativeChatMessage[],
  seed?: NativeChatTaskSeedList | null
): NativeChatTaskList | null {
  return fillTaskBook(messages, seed).list()
}

/** Same list, keeping provider ids so a later TaskUpdate edits the row instead of adding one. */
export function latestNativeChatTaskSeed(
  messages: readonly NativeChatMessage[]
): NativeChatTaskSeedList | null {
  const seed = fillTaskBook(messages).seed()
  return seed && seed.tasks.length > 0 ? seed : null
}

function fillTaskBook(
  messages: readonly NativeChatMessage[],
  seed?: NativeChatTaskSeedList | null
): NativeChatTaskBook {
  const book = createNativeChatTaskBook()
  if (seed && seed.tasks.length > 0) {
    book.replace(seed)
  }
  for (const message of messages) {
    const pairs = new Map(
      pairToolBlocks(message.blocks).flatMap((pair) =>
        pair.call ? [[pair.call, pair] as const] : []
      )
    )
    for (const block of message.blocks) {
      if (block.type === 'text') {
        if (block.presentation === 'plan-document') {
          const plan = nativeChatTaskListFromPlanDocument(block.text)
          if (plan) {
            book.replace(plan)
          }
        }
        const frame = block.providerFrame
        if (frame?.kind === CODEX_PLAN_UPDATED_FRAME_KIND && !frame.payload.truncated) {
          const plan = normalizeNativeChatTaskList('update_plan', frame.payload.head)
          if (plan) {
            book.replace(plan)
          }
        }
        continue
      }
      if (block.type !== 'tool-call') {
        continue
      }
      const pair = pairs.get(block)
      if (!pair?.call || pair.call.state === 'failed' || pair.result?.isError) {
        continue
      }
      const call = readNativeChatTaskListCall(pair.call.name, pair.call.input)
      if (call) {
        const next = applyNativeChatTaskListCall(book.seed(), call)
        if (next) {
          book.replace(next)
        }
        continue
      }
      book.applyClaude(pair.call.name, pair.call.input, pair.result?.output)
    }
  }
  return book
}
