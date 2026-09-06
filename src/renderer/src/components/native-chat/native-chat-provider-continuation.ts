import { useSyncExternalStore } from 'react'
import {
  AGENT_SESSION_CONTINUATION_PROMPT_LEAD,
  buildAgentSessionContinuationPrompt
} from '../../../../shared/agent-session-continuation'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { StructuredSwitchableAgent } from '../../../../shared/structured-agent-session-switchable-models'
import type { NativeChatSendHandle } from './native-chat-runtime-send'
import { setBoundedScopeCacheEntry } from './native-chat-composer-scope-cache'
import {
  loadNativeChatProviderContinuations,
  persistNativeChatProviderContinuations
} from './native-chat-provider-continuation-storage'

export type NativeChatProviderContinuation = {
  agent: StructuredSwitchableAgent
  sourcePtyId: string
  targetPtyId: string | null
  messages: NativeChatMessage[]
  context: string | null
  firstSend?: { wireText: string; visibleText: string }
}

const switchingPanes = new Set<string>()

export function isNativeChatProviderSwitching(paneKey: string): boolean {
  return switchingPanes.has(paneKey)
}

export function beginNativeChatProviderSwitch(paneKey: string): () => void {
  switchingPanes.add(paneKey)
  return () => {
    switchingPanes.delete(paneKey)
  }
}

let continuations = loadNativeChatProviderContinuations()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function readNativeChatProviderContinuation(paneKey: string) {
  return continuations.get(paneKey) ?? null
}

export function useNativeChatProviderContinuation(paneKey: string) {
  return useSyncExternalStore(subscribe, () => readNativeChatProviderContinuation(paneKey))
}

export function writeNativeChatProviderContinuation(
  paneKey: string,
  value: NativeChatProviderContinuation | null
) {
  const next = new Map(continuations)
  if (value) {
    setBoundedScopeCacheEntry(next, paneKey, value)
  } else {
    next.delete(paneKey)
  }
  persistNativeChatProviderContinuations(next)
  continuations = next
  for (const listener of listeners) {
    listener()
  }
}

export function stageNativeChatProviderContinuation(args: {
  paneKey: string
  sourcePtyId: string
  agent: StructuredSwitchableAgent
  messages: NativeChatMessage[]
  transcriptPath: string | null
}) {
  const previous = readNativeChatProviderContinuation(args.paneKey)
  const capturedText = args.messages
    .map((message) => JSON.stringify(message))
    .join('\n')
    .slice(-36_000)
  writeNativeChatProviderContinuation(args.paneKey, {
    agent: args.agent,
    sourcePtyId: args.sourcePtyId,
    targetPtyId: null,
    messages: args.messages,
    context: buildAgentSessionContinuationPrompt(
      {
        sourceAgent: null,
        capturedText,
        // Embed visible history so switching does not depend on a later file read.
        transcriptPath: capturedText.trim() ? null : args.transcriptPath
      },
      'focused'
    )
  })
  return () => writeNativeChatProviderContinuation(args.paneKey, previous)
}

export function bindNativeChatProviderContinuation(
  paneKey: string,
  sourcePtyId: string,
  targetPtyId: string
) {
  const continuation = readNativeChatProviderContinuation(paneKey)
  if (continuation?.sourcePtyId === sourcePtyId) {
    writeNativeChatProviderContinuation(paneKey, { ...continuation, targetPtyId })
  }
}

export function withNativeChatProviderHistory(
  continuation: NativeChatProviderContinuation | null,
  agent: string,
  messages: NativeChatMessage[],
  targetPtyId?: string | null
): NativeChatMessage[] {
  if (
    !continuation ||
    (continuation.agent !== agent && (!targetPtyId || continuation.targetPtyId !== targetPtyId))
  ) {
    return messages
  }
  const { firstSend } = continuation
  const visible = firstSend
    ? messages.map((message) => {
        if (message.role !== 'user') {
          return message
        }
        return {
          ...message,
          blocks: message.blocks.map((block) =>
            block.type === 'text'
              ? { ...block, text: redactContinuationSend(block.text, firstSend) }
              : block
          )
        }
      })
    : messages
  const priorIds = new Set(continuation.messages.map((message) => message.id))
  return [...continuation.messages, ...visible.filter((message) => !priorIds.has(message.id))]
}

function redactContinuationSend(
  text: string,
  firstSend: NonNullable<NativeChatProviderContinuation['firstSend']>
): string {
  if (text.includes(firstSend.wireText)) {
    return text.replace(firstSend.wireText, firstSend.visibleText)
  }
  // Some TUI transcripts truncate the opening line; require the entire remaining wire text.
  const offset = firstSend.wireText.indexOf(text.slice(0, 128))
  if (
    text.length >= 128 &&
    offset > 0 &&
    offset < AGENT_SESSION_CONTINUATION_PROMPT_LEAD.length &&
    text.startsWith(firstSend.wireText.slice(offset))
  ) {
    return firstSend.visibleText + text.slice(firstSend.wireText.length - offset)
  }
  return text
}

export function prepareNativeChatContinuationSend(args: {
  paneKey: string
  agent: string
  ptyId: string
  text: string
}): { text: string; track: (handle: NativeChatSendHandle) => NativeChatSendHandle } {
  const continuation = readNativeChatProviderContinuation(args.paneKey)
  if (
    !continuation?.context ||
    continuation.firstSend ||
    (continuation.agent !== args.agent && continuation.targetPtyId !== args.ptyId) ||
    (continuation.sourcePtyId === args.ptyId && continuation.targetPtyId !== args.ptyId) ||
    (continuation.targetPtyId && continuation.targetPtyId !== args.ptyId)
  ) {
    return { text: args.text, track: (handle) => handle }
  }
  const firstSend = {
    visibleText: args.text,
    wireText: `${continuation.context}\n\nCurrent user message:\n${args.text}`
  }
  writeNativeChatProviderContinuation(args.paneKey, {
    ...continuation,
    targetPtyId: args.ptyId,
    firstSend
  })
  const restoreUnsubmitted = () => {
    if (readNativeChatProviderContinuation(args.paneKey)?.firstSend === firstSend) {
      writeNativeChatProviderContinuation(args.paneKey, continuation)
    }
  }
  return {
    text: firstSend.wireText,
    track: (handle) => {
      void handle.settled?.then(() => {
        if (handle.wasSubmitted?.() === false) {
          restoreUnsubmitted()
        }
      })
      return {
        ...handle,
        cancel: () => {
          handle.cancel()
          if (handle.wasSubmitted?.() !== true) {
            restoreUnsubmitted()
          }
        }
      }
    }
  }
}
