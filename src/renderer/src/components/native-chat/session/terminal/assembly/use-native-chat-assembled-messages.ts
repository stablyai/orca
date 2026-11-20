import { useLayoutEffect, useMemo, useRef } from 'react'
import type { AgentType } from '../../../../../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import {
  applyAppends,
  createIncrementalAssembler,
  type IncrementalChatAssembler,
  reset as resetAssembler,
  rewind as rewindAssembler
} from './native-chat-incremental-assembler'
import { prepareNativeChatLiveMessages } from './native-chat-live-message-preparation'

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

function sharedPrefixLength(
  next: readonly NativeChatMessage[],
  previous: readonly NativeChatMessage[]
): number {
  const limit = Math.min(next.length, previous.length)
  let index = 0
  while (index < limit && next[index] === previous[index]) {
    index += 1
  }
  return index
}

/** Assembles the next transcript from the last committed cache without mutating it. */
function assembleTranscript(
  committed: AssemblyCache | null,
  agent: AgentType,
  sessionId: string | null,
  baseMessages: readonly NativeChatMessage[],
  appended: NativeChatMessage[]
): AssemblyCache {
  const transcript =
    appended.length > 0 ? [...baseMessages, ...appended] : (baseMessages as NativeChatMessage[])
  const baseSignature = `${agent}\u0000${sessionId ?? ''}`
  if (!committed || baseSignature !== committed.baseSignature) {
    const assembler = createIncrementalAssembler()
    const assembledMessages = resetAssembler(assembler, transcript)
    return { assembler, baseSignature, baseMessages, transcript, assembledMessages }
  }
  const applied = committed.transcript
  // A discarded render must not mutate the last committed assembler.
  const assembler = cloneAssembler(committed.assembler)
  if (baseMessages === committed.baseMessages) {
    if (transcript.length >= applied.length && sharesPrefix(transcript, applied, applied.length)) {
      const assembledMessages =
        transcript.length > applied.length
          ? applyAppends(assembler, transcript.slice(applied.length))
          : assembler.messages
      return { assembler, baseSignature, baseMessages, transcript, assembledMessages }
    }
  } else {
    // A re-sent latest window keeps the held rows before it, so only the rows after them re-merge.
    const keep = sharedPrefixLength(transcript, applied)
    if (keep > 0 && rewindAssembler(assembler, applied, keep)) {
      const assembledMessages = applyAppends(assembler, transcript.slice(keep))
      return { assembler, baseSignature, baseMessages, transcript, assembledMessages }
    }
  }
  const assembledMessages = resetAssembler(assembler, transcript)
  return { assembler, baseSignature, baseMessages, transcript, assembledMessages }
}

/** Keeps transcript assembly off the status-only render axis. */
export function useNativeChatAssembledMessages(args: {
  agent: AgentType
  sessionId: string | null
  baseMessages: readonly NativeChatMessage[]
  appended: NativeChatMessage[]
}): { assembledMessages: NativeChatMessage[]; normalizedMessages: NativeChatMessage[] } {
  const committedCacheRef = useRef<AssemblyCache | null>(null)
  const { agent, sessionId, baseMessages, appended } = args

  const assembly = useMemo<AssemblyCache>(
    () => assembleTranscript(committedCacheRef.current, agent, sessionId, baseMessages, appended),
    [agent, appended, baseMessages, sessionId]
  )

  useLayoutEffect(() => {
    committedCacheRef.current = assembly
  }, [assembly])

  const normalizedMessages = useMemo(
    () => prepareNativeChatLiveMessages(assembly.assembledMessages, agent),
    [agent, assembly.assembledMessages]
  )
  return { assembledMessages: assembly.assembledMessages, normalizedMessages }
}
