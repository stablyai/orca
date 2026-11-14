import { useMemo } from 'react'
import type {
  NativeChatBlock,
  NativeChatMessage
} from '../../../../../../shared/native-chat/native-chat-types'
import { deriveNativeChatRowContent } from '../../../../../../shared/native-chat/transcript/row-content/native-chat-row-content'
import {
  nativeChatWorkRunEditKey,
  nativeChatWorkRunEntries
} from '../../../../../../shared/native-chat/native-chat-work-run'
import { NativeChatReasoningRow } from '../../messages/reasoning/NativeChatReasoningRow'
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

export function useNativeChatWorkRun(
  members: readonly NativeChatMessage[] | undefined,
  {
    revealedDiff,
    activeTurnIsWorking
  }: {
    revealedDiff: NativeChatDiffReveal | undefined
    activeTurnIsWorking: boolean | undefined
  }
): NativeChatWorkRun | undefined {
  const entries = useMemo(() => {
    if (!members) {
      return undefined
    }
    const { blocks, thoughtsBefore, thoughtsAfter } = nativeChatWorkRunEntries(members)
    const thought = (message: NativeChatMessage): React.JSX.Element => (
      // Keyed by the thought, so it stays mounted as calls arrive after it.
      <NativeChatReasoningRow
        key={`thought:${message.id}`}
        message={message}
        markdown={deriveNativeChatRowContent(message.blocks).markdown}
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
  return entries && { ...entries, revealedDiff: runReveal }
}
