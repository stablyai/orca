import { useMemo } from 'react'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import type { NativeChatBlock, NativeChatMessage } from '../../../../shared/native-chat-types'
import { deriveNativeChatRowContent } from '../../../../shared/native-chat-row-content'
import {
  nativeChatWorkRunEditKey,
  nativeChatWorkRunEntries
} from '../../../../shared/native-chat/native-chat-work-run'
import { NativeChatReasoningRow } from './NativeChatReasoningRow'
import { ProviderFrameRow } from './NativeChatTranscriptChrome'
import { translate } from '@/i18n/i18n'
import type { NativeChatToolRunAsides } from './NativeChatToolRun'
import type { NativeChatDiffReveal } from './native-chat-turn-diffs'

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
    activeTurnIsWorking,
    onLinkClick,
    allowFileUriLinks
  }: {
    revealedDiff: NativeChatDiffReveal | undefined
    activeTurnIsWorking: boolean | undefined
    onLinkClick: CommentMarkdownLinkClickHandler | undefined
    allowFileUriLinks: boolean
  }
): NativeChatWorkRun | undefined {
  const entries = useMemo(() => {
    if (!members) {
      return undefined
    }
    const { blocks, asidesBefore, asidesAfter } = nativeChatWorkRunEntries(members)
    const aside = (message: NativeChatMessage): React.JSX.Element => {
      const occurrences = new Map<string, number>()
      return message.role === 'system' ? (
        <div key={`notice:${message.id}`} data-native-chat-activity-message-id={message.id}>
          {message.blocks.map((block) => {
            if (block.type !== 'text') {
              return null
            }
            const identity = JSON.stringify(block)
            const occurrence = (occurrences.get(identity) ?? 0) + 1
            occurrences.set(identity, occurrence)
            return (
              <div
                key={`${identity}:${occurrence}`}
                className="space-y-1 py-1 text-sm text-chat-foreground-faint"
              >
                <p className="whitespace-pre-wrap break-words">{block.text}</p>
                <ProviderFrameRow
                  block={block}
                  summary={translate('components.native-chat.notices.details', 'Details')}
                />
              </div>
            )
          })}
        </div>
      ) : (
        // Keyed by the thought, so it stays mounted as calls arrive after it.
        <NativeChatReasoningRow
          key={`thought:${message.id}`}
          message={message}
          markdown={deriveNativeChatRowContent(message.blocks).markdown}
          turnIsWorking={activeTurnIsWorking}
          onLinkClick={onLinkClick}
          allowFileUriLinks={allowFileUriLinks}
        />
      )
    }
    const before = new Map<NativeChatBlock, React.JSX.Element[]>()
    for (const [block, asides] of asidesBefore) {
      before.set(block, asides.map(aside))
    }
    return {
      blocks,
      asides: { before, after: asidesAfter.map(aside) }
    }
  }, [members, activeTurnIsWorking, onLinkClick, allowFileUriLinks])
  const runReveal = useMemo(() => {
    const editKey =
      entries && revealedDiff
        ? nativeChatWorkRunEditKey(members ?? [], entries.blocks, revealedDiff)
        : null
    return revealedDiff && editKey ? { ...revealedDiff, editKey } : undefined
  }, [entries, members, revealedDiff])
  return entries && { ...entries, revealedDiff: runReveal }
}
