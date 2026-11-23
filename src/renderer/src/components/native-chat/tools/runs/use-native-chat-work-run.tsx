import { createContext, useContext, useMemo } from 'react'
import type {
  NativeChatBlock,
  NativeChatMessage
} from '../../../../../../shared/native-chat/native-chat-types'
import { deriveNativeChatRowContent } from '../../../../../../shared/native-chat/transcript/row-content/native-chat-row-content'
import {
  nativeChatWorkRunEditKey,
  nativeChatWorkRunEntries
} from '../../../../../../shared/native-chat/transcript/folding/native-chat-work-run'
import { NativeChatReasoningRow } from '../../messages/reasoning/NativeChatReasoningRow'
import { stageBesideStreamedText } from '../../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'
import type { NativeChatToolRunAsides } from './NativeChatToolRun'
import type { NativeChatDiffReveal } from '../../../../../../shared/native-chat/tools/native-chat-turn-diffs'

export type NativeChatWorkRun = {
  /** Every member's tool blocks, in order: the run's one block list. */
  blocks: NativeChatBlock[]
  /** The thoughts, among the calls they came between. */
  asides: NativeChatToolRunAsides
  /** The diff reveal aimed at a member, in the run's own edit numbering. */
  revealedDiff: NativeChatDiffReveal | undefined
}

/** A run's members whose text streamed since its calls were laid out, by id. */
export const NativeChatWorkRunStreamedContext = createContext<ReadonlyMap<
  string,
  NativeChatMessage
> | null>(null)

/** A thought among a run's calls, drawn with its newest streamed text. */
function NativeChatWorkRunThought({
  message,
  turnIsWorking
}: {
  message: NativeChatMessage
  turnIsWorking: boolean | undefined
}): React.JSX.Element | null {
  const current = useContext(NativeChatWorkRunStreamedContext)?.get(message.id) ?? message
  return (
    <NativeChatReasoningRow
      message={current}
      markdown={deriveNativeChatRowContent(current.blocks).markdown}
      turnIsWorking={turnIsWorking}
    />
  )
}

/** Members that differ from the run as laid out; null when none do. */
export function useNativeChatWorkRunStreamed(
  members: readonly NativeChatMessage[] | undefined
): ReadonlyMap<string, NativeChatMessage> | null {
  return useMemo(() => {
    const laidOut = members && stageBesideStreamedText(members)
    if (!members || laidOut === members) {
      return null
    }
    const streamed = new Map<string, NativeChatMessage>()
    members.forEach((member, index) => {
      if (member !== laidOut![index]) {
        streamed.set(member.id, member)
      }
    })
    return streamed
  }, [members])
}

export function useNativeChatWorkRun(
  streamedMembers: readonly NativeChatMessage[] | undefined,
  {
    revealedDiff,
    activeTurnIsWorking
  }: {
    revealedDiff: NativeChatDiffReveal | undefined
    activeTurnIsWorking: boolean | undefined
  }
): NativeChatWorkRun | undefined {
  // Laid out from the run before its thoughts streamed: their text reaches them by context, so a
  // streaming thought leaves the calls, header and asides as they were.
  const members = streamedMembers && stageBesideStreamedText(streamedMembers)
  const entries = useMemo(() => {
    if (!members) {
      return undefined
    }
    const { blocks, thoughtsBefore, thoughtsAfter } = nativeChatWorkRunEntries(members)
    const thought = (message: NativeChatMessage): React.JSX.Element => (
      // Keyed by the thought, so it stays mounted as calls arrive after it.
      <NativeChatWorkRunThought
        key={`thought:${message.id}`}
        message={message}
        turnIsWorking={activeTurnIsWorking}
      />
    )
    const before = new Map<NativeChatBlock, React.JSX.Element[]>()
    for (const [block, thoughts] of thoughtsBefore) {
      before.set(block, thoughts.map(thought))
    }
    return {
      blocks,
      asides: { before, after: thoughtsAfter.map(thought) }
    }
  }, [members, activeTurnIsWorking])
  const runReveal = useMemo(() => {
    const editKey =
      entries && revealedDiff
        ? nativeChatWorkRunEditKey(members ?? [], entries.blocks, revealedDiff)
        : null
    return revealedDiff && editKey ? { ...revealedDiff, editKey } : undefined
  }, [entries, members, revealedDiff])
  return useMemo(() => entries && { ...entries, revealedDiff: runReveal }, [entries, runReveal])
}
