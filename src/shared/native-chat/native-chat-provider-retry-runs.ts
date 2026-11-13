// Keep every retry in the journal but draw only each agent run’s latest retry row, preserving intervening non-retry rows.

import { agentJournalItemSubagentId } from '../agent-session/journal/agent-session-journal-producer'
import type { NativeChatMessage } from './native-chat-types'
import { isNativeChatContextClear } from '../agent-session/agent-session-context-clear'

export function isNativeChatProviderRetryRow(message: NativeChatMessage): boolean {
  const block = message.blocks.length === 1 ? message.blocks[0] : undefined
  return (
    message.role === 'system' &&
    block?.type === 'text' &&
    block.failure?.kind === 'providerRetrying'
  )
}

/** One consumer's stamped rows from its last pass, so an unchanged run keeps its row object. */
export type NativeChatProviderRetryStamps = {
  generation: Map<NativeChatMessage, NativeChatMessage>
}

export function createNativeChatProviderRetryStamps(): NativeChatProviderRetryStamps {
  return { generation: new Map() }
}

type ProviderRetryRun = { at: number; source: NativeChatMessage; ids: string[] }

function sameIds(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  )
}

/** Track runs per agent: interleaved conversation/subagent sections cannot end or hide one another’s runs. */
export function collapseProviderRetryRuns(
  messages: readonly NativeChatMessage[],
  stamps?: NativeChatProviderRetryStamps
): readonly NativeChatMessage[] {
  const previous = stamps?.generation
  // Replaced on every pass so no stamp outlives the output that draws it.
  const generation = new Map<NativeChatMessage, NativeChatMessage>()
  if (stamps) {
    stamps.generation = generation
  }
  if (!messages.some(isNativeChatProviderRetryRow)) {
    return messages
  }
  const openRuns = new Map<string | null, ProviderRetryRun>()
  const runs: ProviderRetryRun[] = []
  const drawn: (NativeChatMessage | null)[] = []
  for (const message of messages) {
    if (isNativeChatContextClear(message)) {
      openRuns.clear()
    }
    if (!isNativeChatProviderRetryRow(message)) {
      if (openRuns.size > 0) {
        openRuns.delete(agentJournalItemSubagentId(message))
      }
      drawn.push(message)
      continue
    }
    const agent = agentJournalItemSubagentId(message)
    const run = openRuns.get(agent)
    if (run) {
      drawn[run.at] = null
      run.at = drawn.length
      run.source = message
      run.ids.push(message.id)
    } else {
      const started = { at: drawn.length, source: message, ids: [message.id] }
      openRuns.set(agent, started)
      runs.push(started)
    }
    drawn.push(message)
  }
  for (const run of runs) {
    if (run.ids.length < 2) {
      continue
    }
    const kept = previous?.get(run.source)
    const row =
      kept && sameIds(kept.providerRetryRunIds, run.ids)
        ? kept
        : { ...run.source, providerRetryRunIds: run.ids }
    generation.set(run.source, row)
    drawn[run.at] = row
  }
  return drawn.filter((message) => message !== null)
}
