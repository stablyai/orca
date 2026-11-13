// What the main agent asked a subagent to do and, for Claude, the reply its spawn call returned.

import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { codexCollabRowAgentIds } from '../../../../../shared/codex-collab-agent-tools'
import {
  isSubagentBlock,
  isToolCallBlock,
  type NativeChatMessage
} from '../../../../../shared/native-chat/native-chat-types'
import type { NativeChatSubagentRow } from '../../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import { pairNativeChatToolResults } from '../../../../../shared/native-chat/tools/native-chat-tool-pairing'

export type NativeChatSubagentHandoff = {
  prompt: string | null
  /** The spawn call's result: Claude's `Agent` call returns the subagent's whole final reply. */
  reply: string | null
}

const NO_HANDOFF: NativeChatSubagentHandoff = { prompt: null, reply: null }

/** Claude names the spawning `Agent` call as the run of the subagent's newest revision. */
function spawnRunOf(
  journalItems: readonly AgentJournalRenderItem[] | undefined,
  agentId: string
): string | undefined {
  for (let index = (journalItems?.length ?? 0) - 1; index >= 0; index -= 1) {
    const body = journalItems![index]!.body
    if (body.kind !== 'message') {
      continue
    }
    const block = body.blocks.find(
      (candidate) => isSubagentBlock(candidate) && candidate.id === agentId
    )
    if (block && isSubagentBlock(block) && block.run !== undefined) {
      return block.run
    }
  }
  return undefined
}

/** Claude frames the report it hands back: a column-zero `[Subagent hand-back]` line, then every report line indented two spaces. */
function handBackReport(output: string): string {
  const lines = output.split('\n')
  const frame = lines.findLastIndex((line) => line.startsWith('[Subagent hand-back]'))
  return frame === -1
    ? output.trim()
    : lines
        .slice(frame + 1)
        .map((line) => line.replace(/^ {2}/, ''))
        .join('\n')
        .trim()
}

function promptOf(input: unknown): string | null {
  const prompt =
    typeof input === 'object' && input !== null && 'prompt' in input ? input.prompt : null
  return typeof prompt === 'string' && prompt.trim() ? prompt : null
}

/** The spawn call is Claude's call named by the run, or the Codex `spawn_agent` call naming the child. */
export function nativeChatSubagentHandoff({
  agentId,
  journalItems,
  conversation,
  subagentRows
}: {
  agentId: string
  journalItems: readonly AgentJournalRenderItem[] | undefined
  conversation: readonly NativeChatMessage[]
  subagentRows: ReadonlyMap<string, readonly NativeChatSubagentRow[]>
}): NativeChatSubagentHandoff {
  const run = spawnRunOf(journalItems, agentId)
  const spawners = [
    conversation,
    ...Array.from(subagentRows.values(), (rows) => rows.map(({ message }) => message))
  ]
  for (const messages of spawners) {
    for (const message of messages) {
      for (const block of message.blocks) {
        if (!isToolCallBlock(block)) {
          continue
        }
        if (run !== undefined && block.callId === run) {
          const result = pairNativeChatToolResults(message.blocks).resultByCall.get(block)
          return {
            prompt: promptOf(block.input),
            reply: (result && !result.isError && handBackReport(result.output)) || null
          }
        }
        if (block.name === 'spawn_agent' && codexCollabRowAgentIds(block.input).includes(agentId)) {
          return { prompt: promptOf(block.input), reply: null }
        }
      }
    }
  }
  return NO_HANDOFF
}
