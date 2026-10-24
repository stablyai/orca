import type { NativeChatTranscriptRowContext } from './NativeChatTranscriptRow'
import {
  createNativeChatReturnField,
  useNativeChatReturnState
} from './native-chat-view-state-memory'
import type { NativeChatDiffReveal } from './native-chat-turn-diffs'

export type NavigationRequest =
  | { kind: 'diff'; target: NativeChatDiffReveal }
  | { kind: 'rail'; messageId: string; requestId: number }

export const expandedTurns = createNativeChatReturnField<ReadonlySet<string>>()

export type NativeChatTranscriptOptions = Pick<
  NativeChatTranscriptRowContext,
  'expandSignal' | 'onLinkClick' | 'deliveryNotices' | 'runtimeContext'
> & { allowFileUriLinks?: boolean }

export function useNativeChatExpandedTurns() {
  return useNativeChatReturnState(expandedTurns, () => new Set())
}
