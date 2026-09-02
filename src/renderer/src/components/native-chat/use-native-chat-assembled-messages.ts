import { useLayoutEffect, useMemo, useRef } from 'react'
import type { AgentType, NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  applyAppends,
  createIncrementalAssembler,
  type IncrementalChatAssembler,
  reset as resetAssembler
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

/** Keeps transcript assembly off the status-only render axis. */
export function useNativeChatAssembledMessages(args: {
  agent: AgentType
  sessionId: string | null
  baseMessages: readonly NativeChatMessage[]
  appended: NativeChatMessage[]
}): { assembledMessages: NativeChatMessage[]; normalizedMessages: NativeChatMessage[] } {
  const committedCacheRef = useRef<AssemblyCache | null>(null)
  const { agent, sessionId, baseMessages, appended } = args

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

  const normalizedMessages = useMemo(
    () => prepareNativeChatLiveMessages(assembly.assembledMessages, agent),
    [agent, assembly.assembledMessages]
  )
  return { assembledMessages: assembly.assembledMessages, normalizedMessages }
}
