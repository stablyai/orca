import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { NativeChatTranscriptSlot } from '../../conversation/slots/native-chat-transcript-slots'
import { toggleNativeChatExpandedKey } from './native-chat-expanded-keys'

export type NativeChatCollapsedResponses = {
  /** Person prompts that have response rows to fold. */
  answered: ReadonlySet<string>
  collapsed: ReadonlySet<string>
  toggle: (promptId: string) => void
}

export const NativeChatCollapsedResponsesContext =
  createContext<NativeChatCollapsedResponses | null>(null)

export function useNativeChatCollapsedResponse(promptId: string): {
  answered: boolean
  collapsed: boolean
  toggle: () => void
} | null {
  const responses = useContext(NativeChatCollapsedResponsesContext)
  if (!responses) {
    return null
  }
  return {
    answered: responses.answered.has(promptId),
    collapsed: responses.collapsed.has(promptId),
    toggle: () => responses.toggle(promptId)
  }
}

/** The person prompt a top-level slot opens; agent-authored input (`from`) belongs to the response. */
function personPromptId(slot: NativeChatTranscriptSlot): string | undefined {
  return slot.kind === 'message' && slot.message.role === 'user' && !slot.message.from
    ? slot.message.id
    : undefined
}

/** Each slot's prompt: the nearest person prompt above it; prompts themselves own nothing. */
function nativeChatResponseOwners(
  slots: readonly NativeChatTranscriptSlot[]
): readonly (string | undefined)[] {
  const owners: (string | undefined)[] = []
  let promptId: string | undefined
  for (const slot of slots) {
    const opened = personPromptId(slot)
    owners.push(opened === undefined ? promptId : undefined)
    promptId = opened ?? promptId
  }
  return owners
}

/**
 * Drop each collapsed prompt's response: the drawn slots up to the next person prompt, so a steer
 * owns the reply after it. Slots are built from every row first, so turn state and the side-chat fork
 * point never depend on what is folded.
 */
export function useNativeChatResponseFolding(
  transcript: { slots: readonly NativeChatTranscriptSlot[] },
  live: {
    liveTurnKey: string | undefined
    awaitingInput: unknown
    hostWork: { actionablePromptIds?: readonly string[] } | undefined
  }
): { slots: readonly NativeChatTranscriptSlot[]; responses: NativeChatCollapsedResponses } {
  const { slots } = transcript
  // The live turn waits on the reader (a permission, a question): its response cannot stay folded.
  const needsReader =
    live.awaitingInput !== null || Boolean(live.hostWork?.actionablePromptIds?.length)
  const liveTurnKey = live.liveTurnKey
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const toggle = useCallback((promptId: string) => {
    setCollapsed((current) => toggleNativeChatExpandedKey(current, promptId))
  }, [])
  const owners = useMemo(() => nativeChatResponseOwners(slots), [slots])
  const held = useMemo(() => {
    if (!needsReader) {
      return new Set<string>()
    }
    const liveOwners = slots.flatMap((slot, index) =>
      slot.kind === 'message' && slot.turnKey === liveTurnKey && owners[index] !== undefined
        ? [owners[index]]
        : []
    )
    // Without a live turn key the reader owes the newest prompt.
    const newest = owners.findLast((owner) => owner !== undefined)
    return new Set(liveTurnKey === undefined && newest !== undefined ? [newest] : liveOwners)
  }, [liveTurnKey, needsReader, owners, slots])
  // Unfold for good: answering the agent must not fold its reply away again.
  if ([...held].some((promptId) => collapsed.has(promptId))) {
    setCollapsed((current) => new Set([...current].filter((promptId) => !held.has(promptId))))
  }
  return useMemo(() => {
    const answered = new Set(
      owners.flatMap((owner) => (owner !== undefined && !held.has(owner) ? [owner] : []))
    )
    const folded = (owner: string | undefined): boolean =>
      owner !== undefined && !held.has(owner) && collapsed.has(owner)
    const shown = owners.some(folded) ? slots.filter((_, index) => !folded(owners[index])) : slots
    return { slots: shown, responses: { answered, collapsed, toggle } }
  }, [collapsed, held, owners, slots, toggle])
}
