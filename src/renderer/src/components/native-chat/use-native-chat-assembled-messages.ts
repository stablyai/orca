import { useLayoutEffect, useMemo, useRef } from 'react'
import type { AgentType, NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  applyAppends,
  createIncrementalAssembler,
  type IncrementalChatAssembler,
  reset as resetAssembler
} from './native-chat-incremental-assembler'
import { prepareNativeChatLiveMessages } from './native-chat-live-message-preparation'
import { mergeOmpRpcHydratedHistory } from './native-chat-rpc-history-merge'

/** Stable empty reference so a pane with no hydrated history never churns the
 *  merge memo below. */
const NO_RPC_HISTORY: readonly NativeChatMessage[] = []

type AssemblyCache = {
  assembler: IncrementalChatAssembler
  baseSignature: string
  baseMessages: readonly NativeChatMessage[]
  transcript: readonly NativeChatMessage[]
  assembledMessages: NativeChatMessage[]
}

function cloneAssembler(assembler: IncrementalChatAssembler): IncrementalChatAssembler {
  return {
    byId: new Map(assembler.byId),
    byTurn: new Map(assembler.byTurn),
    messages: assembler.messages
  }
}

function sharesPrefix(
  whole: readonly NativeChatMessage[],
  prefix: readonly NativeChatMessage[],
  length: number
): boolean {
  for (let index = 0; index < length; index += 1) {
    if (whole[index] !== prefix[index]) {
      return false
    }
  }
  return true
}

/** The assembled list re-ordered back into the transcript's own RECORD order.
 *
 *  Why (XLR-R6-007, cross-lab review): the hydration aligner walks the two
 *  windows in record order and matches greedily forward
 *  (native-chat-rpc-history-merge.ts), so a transcript whose records have been
 *  re-sorted relative to the snapshot breaks it — `compareMessages` ties on
 *  equal timestamps are broken by the entry id, which for omp is a random uuid
 *  (transcript-line-decoders-omp.ts), so three same-instant records can arrive
 *  in any order. The cursor then anchors a later record first and can no longer
 *  match the earlier one behind it, which the walk emits again as unanchored —
 *  duplicating a real turn in the rendered list.
 *
 *  Returns the input by identity when the order already agrees, so the memoized
 *  consumers below keep their reference. Ranked, never sorted by clock: the
 *  record order IS the answer, and a record the transcript list no longer names
 *  (defensive — every assembled record comes from it) keeps its position at the
 *  tail rather than being dropped. */
export function orderNativeChatMessagesByRecord(
  assembled: readonly NativeChatMessage[],
  transcript: readonly NativeChatMessage[]
): NativeChatMessage[] {
  const recordIndexById = new Map<string, number>()
  transcript.forEach((message, index) => {
    if (!recordIndexById.has(message.id)) {
      recordIndexById.set(message.id, index)
    }
  })
  const ranked = assembled.map((message, index) => ({
    message,
    index,
    record: recordIndexById.get(message.id) ?? Number.POSITIVE_INFINITY
  }))
  ranked.sort((a, b) => a.record - b.record || a.index - b.index)
  return ranked.every((entry, index) => entry.index === index)
    ? (assembled as NativeChatMessage[])
    : ranked.map((entry) => entry.message)
}

/** Keeps transcript assembly off the status-only render axis. */
export function useNativeChatAssembledMessages(args: {
  agent: AgentType
  sessionId: string | null
  baseMessages: readonly NativeChatMessage[]
  appended: NativeChatMessage[]
  /** Reconnect hydration from the owning RPC session (omp-rpc-history-decode.ts):
   *  merged in AFTER transcript assembly, never through the incremental
   *  assembler, whose prefix cache is keyed on the transcript alone. */
  rpcHistoryMessages?: readonly NativeChatMessage[]
}): { assembledMessages: NativeChatMessage[]; normalizedMessages: NativeChatMessage[] } {
  const committedCacheRef = useRef<AssemblyCache | null>(null)
  const { agent, sessionId, baseMessages, appended, rpcHistoryMessages = NO_RPC_HISTORY } = args

  const assembly = useMemo<AssemblyCache>(() => {
    const committed = committedCacheRef.current
    const transcript =
      appended.length > 0 ? [...baseMessages, ...appended] : (baseMessages as NativeChatMessage[])
    const baseSignature = `${agent}\u0000${sessionId ?? ''}`
    const baseChanged =
      !committed ||
      baseSignature !== committed.baseSignature ||
      baseMessages !== committed.baseMessages
    const applied = committed?.transcript ?? []
    const isSuffixExtension =
      !baseChanged &&
      transcript.length >= applied.length &&
      sharesPrefix(transcript, applied, applied.length)
    // A discarded render must not mutate the last committed assembler.
    const assembler = baseChanged
      ? createIncrementalAssembler()
      : cloneAssembler(committed.assembler)

    const assembledMessages = isSuffixExtension
      ? transcript.length > applied.length
        ? applyAppends(assembler, transcript.slice(applied.length))
        : assembler.messages
      : resetAssembler(assembler, transcript)
    return { assembler, baseSignature, baseMessages, transcript, assembledMessages }
  }, [agent, appended, baseMessages, sessionId])

  useLayoutEffect(() => {
    committedCacheRef.current = assembly
  }, [assembly])

  // Both folds below align against RECORD order, so neither may see the
  // clock-and-id sort the assembler emits (XLR-R6-007). Computed only for a
  // pane that actually hydrated, so the identity fast paths inside both folds
  // still fire for every other pane.
  const recordOrdered = useMemo(
    () =>
      rpcHistoryMessages.length === 0
        ? assembly.assembledMessages
        : orderNativeChatMessagesByRecord(assembly.assembledMessages, assembly.transcript),
    [assembly.assembledMessages, assembly.transcript, rpcHistoryMessages]
  )

  // The transcript wins every turn both sources carry, so this is identity for
  // any pane with nothing hydrated — including every non-OMP pane. This fold is
  // the PRE-dedup list, kept for the status tail the session hook reads: with
  // hydration that tail can be an unflushed RPC record, which is the point.
  const mergedMessages = useMemo(
    () => mergeOmpRpcHydratedHistory(recordOrdered, rpcHistoryMessages),
    [recordOrdered, rpcHistoryMessages]
  )

  // Preparation folds the snapshot in itself, and must: its cross-source pass
  // would otherwise re-collapse turns the fold reconciled by position.
  const normalizedMessages = useMemo(
    () => prepareNativeChatLiveMessages(recordOrdered, agent, rpcHistoryMessages),
    [agent, recordOrdered, rpcHistoryMessages]
  )
  return { assembledMessages: mergedMessages, normalizedMessages }
}
