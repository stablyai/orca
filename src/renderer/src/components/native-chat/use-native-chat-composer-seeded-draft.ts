import { useState } from 'react'
import { useNativeChatDraft } from './use-native-chat-draft'
import { useNativeChatLaunchDraftAdoption } from './use-native-chat-launch-draft-adoption'
import type { NativeChatComposerProps } from './native-chat-composer-types'

export function useNativeChatComposerSeededDraft(
  args: Pick<NativeChatComposerProps, 'terminalTabId' | 'agent' | 'launchSeed'> & {
    draftScopeKey: string
    isComposing: () => boolean
  }
) {
  const { draft, setDraft, flushDraftAppends } = useNativeChatDraft(
    args.draftScopeKey,
    args.isComposing
  )
  const [caret, setCaret] = useState(draft.length)
  useNativeChatLaunchDraftAdoption({
    terminalTabId: args.terminalTabId,
    agent: args.agent,
    launchDraft: args.launchSeed?.launchDraft,
    launchDraftResolved: args.launchSeed?.launchDraftResolved === true,
    ownsTabWideLaunchDraft: args.launchSeed?.ownsTabWideLaunchDraft === true,
    draft,
    setDraft,
    setCaret
  })
  return { draft, setDraft, flushDraftAppends, caret, setCaret }
}
