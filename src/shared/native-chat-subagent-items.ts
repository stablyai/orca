// Hosts revise individual subagent rows at spawn positions; readers fold siblings into legacy-shaped roster rows at the first sibling.
// Shared desktop/mobile grouping supports uncapped spawns and derives disambiguating ordinals without storing them.

import { normalizeSubagentState } from './native-chat-subagent-summary'
import {
  isSubagentBlock,
  isSubagentGroupBlock,
  type NativeChatBlock,
  type NativeChatMessage,
  type NativeChatSubagentBlock,
  type NativeChatSubagentEntry,
  type NativeChatSubagentGroupBlock
} from './native-chat-types'

/** Frozen fallback for older clients; Kicked off means no outcome recorded yet, never current liveness. */
export function subagentFallbackText(block: NativeChatSubagentEntry): string {
  const state = normalizeSubagentState(block.state)
  if (state === 'working') {
    return `Kicked off subagent ${block.label}`
  }
  const adverse = state === 'failed' || state === 'stopped' || state === 'unverifiable'
  return `Ran subagent ${block.label}${adverse ? ` (${state})` : ''}`
}

export function subagentEntryOf(
  block: NativeChatSubagentBlock,
  label = block.label
): NativeChatSubagentEntry {
  return {
    id: block.id,
    label,
    state: block.state,
    ...(block.tokens !== undefined ? { tokens: block.tokens } : {}),
    ...(block.startedAt !== undefined ? { startedAt: block.startedAt } : {}),
    ...(block.settledAt !== undefined ? { settledAt: block.settledAt } : {})
  }
}

export function namedSubagents(block: NativeChatBlock): readonly NativeChatSubagentEntry[] {
  if (isSubagentGroupBlock(block)) {
    return block.agents
  }
  return isSubagentBlock(block) ? [subagentEntryOf(block)] : []
}

/** Group by spawning turn/parent; nested helpers need independent disclosure state. */
export function subagentFoldKey(block: NativeChatSubagentBlock): string {
  return block.parentId === undefined
    ? block.groupId
    : JSON.stringify([block.groupId, block.parentId])
}

/** The subagent a row is, when it is one: its block, beside nothing but its twin sentence. */
export function subagentItemBlock(
  message: Pick<NativeChatMessage, 'blocks'>
): NativeChatSubagentBlock | null {
  let found: NativeChatSubagentBlock | null = null
  for (const block of message.blocks) {
    if (isSubagentBlock(block) && found === null) {
      found = block
    } else if (block.type !== 'text') {
      return null
    }
  }
  return found
}

type Folded = { members: readonly NativeChatMessage[]; row: NativeChatMessage }

/** Cache by first sibling so unchanged groups retain memoized transcript rows during other siblings’ streams. */
const foldedGroups = new WeakMap<NativeChatMessage, Folded>()
const foldedEntries = new WeakMap<NativeChatSubagentBlock, NativeChatSubagentEntry>()

/** Fold sibling rows at the first sibling’s position; preserve every unrelated row. */
export function foldSubagentItems(
  messages: readonly NativeChatMessage[]
): readonly NativeChatMessage[] {
  const groups = new Map<string, NativeChatMessage[]>()
  let any = false
  for (const message of messages) {
    const block = subagentItemBlock(message)
    if (block === null) {
      continue
    }
    any = true
    const key = subagentFoldKey(block)
    const siblings = groups.get(key)
    if (siblings) {
      siblings.push(message)
    } else {
      groups.set(key, [message])
    }
  }
  if (!any) {
    return messages
  }
  const rows = new Map<NativeChatMessage, NativeChatMessage | null>()
  for (const [groupId, members] of groups) {
    const [first, ...rest] = members
    rows.set(first!, groupRow(groupId, members))
    for (const member of rest) {
      rows.set(member, null)
    }
  }
  const folded: NativeChatMessage[] = []
  for (const message of messages) {
    const row = rows.get(message)
    if (row === undefined) {
      folded.push(message)
    } else if (row !== null) {
      folded.push(row)
    }
  }
  return folded
}

function groupRow(groupId: string, members: readonly NativeChatMessage[]): NativeChatMessage {
  const first = members[0]!
  const held = foldedGroups.get(first)
  if (
    held &&
    held.members.length === members.length &&
    held.members.every((member, index) => member === members[index])
  ) {
    return held.row
  }
  const blocks = members.map((member) => subagentItemBlock(member)!)
  const group: NativeChatSubagentGroupBlock = {
    type: 'subagent-group',
    groupId,
    agents: labelledEntries(blocks)
  }
  const row: NativeChatMessage = { ...first, blocks: [group] }
  foldedGroups.set(first, { members: [...members], row })
  return row
}

/** Disambiguate duplicate provider labels with ordinals that avoid existing names, including provider-authored Audit 2. */
function labelledEntries(blocks: readonly NativeChatSubagentBlock[]): NativeChatSubagentEntry[] {
  const taken = new Set<string>()
  const repeated = new Set<string>()
  for (const block of blocks) {
    if (taken.has(block.label)) {
      repeated.add(block.label)
    }
    taken.add(block.label)
  }
  const claimed = new Set<string>()
  return blocks.map((block) => {
    let label = block.label
    if (repeated.has(label) && claimed.has(label)) {
      for (let ordinal = 2; taken.has(label) || claimed.has(label); ordinal++) {
        label = `${block.label} ${ordinal}`
      }
    }
    claimed.add(label)
    const held = foldedEntries.get(block)
    if (held?.label === label) {
      return held
    }
    const entry = subagentEntryOf(block, label)
    foldedEntries.set(block, entry)
    return entry
  })
}
