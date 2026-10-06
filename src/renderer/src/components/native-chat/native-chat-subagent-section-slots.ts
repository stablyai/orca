// Where subagent sections and their roster entries sit among the transcript's slots.

import type {
  NativeChatMessage,
  NativeChatSubagentEntry
} from '../../../../shared/native-chat-types'
import {
  normalizeSubagentState,
  subagentGroupBlocks
} from '../../../../shared/native-chat-subagent-summary'
import { nativeChatRowRendersContent } from '../../../../shared/native-chat-row-content'
import {
  type NativeChatRowTypography,
  estimateNativeChatRowHeight,
  nativeChatRowContentMetrics,
  NATIVE_CHAT_SUBAGENT_SECTION_HEAD_PX
} from './native-chat-row-height-estimate'
import type { NativeChatResolvedPrompt } from './native-chat-resolution-receipt'
import { compareMessages } from './native-chat-session-assembler'
import {
  nativeChatSubagentEntryRuns,
  type NativeChatSubagentChoices,
  type NativeChatSubagentRosterState,
  type NativeChatSubagentSections
} from './native-chat-subagent-sections'
import { nativeChatRowRendersProse, nativeChatRowSpeaksOrActs } from './native-chat-trailing-run'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'

/** The head of a section no loaded roster row holds: it names whose rows follow it. */
export type NativeChatSubagentSectionSlot = {
  kind: 'subagent'
  agentId: string
  /** The conversation turn this head sits in, so the outline rail can place it. */
  turnKey: string | undefined
  /** The roster's entry for the agent; absent when no loaded roster names it. */
  entry: NativeChatSubagentEntry | undefined
  expanded: boolean
  /** Sections this head sits inside; 0 is the conversation. */
  depth: number
  estimatedHeight: number
}

/** A roster row's entries after an open child's rows, through the next open one. */
export type NativeChatSubagentEntriesSlot = {
  kind: 'subagent-entries'
  rosterRowId: string
  agents: readonly NativeChatSubagentEntry[]
  sections: ReadonlyMap<string, boolean>
  turnKey: string | undefined
  depth: number
  estimatedHeight: number
}

/** Emits subagent sections into `slots`: one the session spawned under its entry in the
 *  roster row that names it, while that row's list is open; any other's head where its
 *  first row happened, and its rows once open. A section is open while it is its running
 *  scope's live frontier (`live`); the reader's choice outranks that. A roster list is
 *  open while the frontier or a reader's choice is on one of its sections, unless the
 *  reader closed the list. */
export function nativeChatSubagentSectionSlots({
  sections,
  choices,
  live,
  receipts,
  slots,
  typography
}: {
  sections: NativeChatSubagentSections
  choices: NativeChatSubagentChoices
  live: ReadonlySet<string>
  receipts: ReadonlyMap<string, NativeChatResolvedPrompt>
  slots: NativeChatTranscriptSlot[]
  typography?: NativeChatRowTypography
}) {
  const isOpen = (agentId: string): boolean => choices.sections.get(agentId) ?? live.has(agentId)
  const pushHead = (agentId: string, depth: number, turnKey: string | undefined): void => {
    slots.push({
      kind: 'subagent',
      agentId,
      turnKey,
      entry: sections.entries.get(agentId),
      expanded: isOpen(agentId),
      depth,
      estimatedHeight: NATIVE_CHAT_SUBAGENT_SECTION_HEAD_PX
    })
  }
  /** `turnKey`: the turn the section is shown in. Its rows carry that one, not the
   *  turn each was written in, so the outline rail lights where the reader is. */
  const pushRows = (agentId: string, depth: number, turnKey: string | undefined): void => {
    const rows = sections.rows.get(agentId) ?? []
    // The agent's own frontier: its trailing run is live while the agent works.
    const entry = sections.entries.get(agentId)
    const working = entry !== undefined && normalizeSubagentState(entry.state) === 'working'
    const trailing = rows.findLastIndex((row) =>
      nativeChatRowSpeaksOrActs(row.message, nativeChatRowRendersProse(row.message), receipts)
    )
    const pending = [...(sections.openAt.get(agentId) ?? [])]
    for (const [index, { message }] of rows.entries()) {
      openBefore(pending, message, depth, { turnKey })
      const receipt = receipts.get(message.id)
      if (receipt === undefined && !nativeChatRowRendersContent(message.blocks)) {
        continue
      }
      slots.push({
        kind: 'message',
        message,
        turnKey,
        activeTurnIsWorking: working,
        trailingRun: index === trailing,
        receipt,
        status: undefined,
        folded: false,
        drawsMessage: true,
        turnFolds: false,
        turnDiff: undefined,
        subagentRoster: undefined,
        depth,
        estimatedHeight: estimateNativeChatRowHeight(
          nativeChatRowContentMetrics(message, typography),
          {
            hasReceipt: receipt !== undefined,
            hasStatus: false,
            hasTurnDiff: false,
            inSubagentSection: true
          },
          typography
        )
      })
    }
    openBefore(pending, undefined, depth, { turnKey })
  }
  /** Heads, ahead of `message`, each pending section whose first row came before
   *  it, with its rows when open; `undefined` flushes the rest. Inside a section
   *  each sits in that section's turn; in the conversation, in its first row's. */
  function openBefore(
    pending: string[],
    message: NativeChatMessage | undefined,
    depth: number,
    section?: { turnKey: string | undefined }
  ) {
    while (pending.length > 0) {
      const agentId = pending[0]!
      const first = sections.rows.get(agentId)?.[0]
      if (
        message !== undefined &&
        first !== undefined &&
        compareMessages(first.message, message) >= 0
      ) {
        return
      }
      pending.shift()
      const turnKey = section ? section.turnKey : first?.turnKey
      pushHead(agentId, depth, turnKey)
      if (isOpen(agentId)) {
        pushRows(agentId, depth + 1, turnKey)
      }
    }
  }
  return {
    openBefore,
    /** Each open child's rows under its entry, then the entries up to the next open one. */
    openAnchoredAt(
      message: NativeChatMessage,
      roster: NativeChatSubagentRosterState | undefined,
      turnKey: string | undefined
    ): void {
      if (!roster?.open) {
        return
      }
      for (const group of subagentGroupBlocks(message.blocks)) {
        let opened: string | undefined
        for (const agents of nativeChatSubagentEntryRuns(group.agents, roster.sections)) {
          if (opened !== undefined) {
            pushRows(opened, 1, turnKey)
            if (agents.length > 0) {
              slots.push({
                kind: 'subagent-entries',
                rosterRowId: message.id,
                agents,
                sections: roster.sections,
                turnKey,
                depth: 0,
                estimatedHeight: agents.length * NATIVE_CHAT_SUBAGENT_SECTION_HEAD_PX
              })
            }
          }
          opened = agents.at(-1)?.id
        }
      }
    },
    rosterAt(messageId: string): NativeChatSubagentRosterState | undefined {
      const anchored = sections.anchoredAt.get(messageId)
      return anchored === undefined
        ? undefined
        : {
            open:
              choices.rosters.get(messageId) ??
              anchored.some((agentId) => choices.sections.has(agentId) || live.has(agentId)),
            sections: new Map(anchored.map((agentId) => [agentId, isOpen(agentId)]))
          }
    }
  }
}
