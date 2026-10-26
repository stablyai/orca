import { agentDeliversDraftViaNativePrefill } from '@/lib/agent-native-draft-prefill'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { canMirrorLaunchDraftToNativeChat } from '@/lib/native-chat-launch-draft-mirrorability'
import { isNativeChatSupportedAgent } from '@/lib/native-chat-supported-agent'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../shared/tui-agent'

/** Mirror TUI-only launch context into supported native-chat composers, using the same eligibility predicate as chat opening. */
export function seedNativeChatLaunchDraftForAgentTab(args: {
  tabId: string
  agent: TuiAgent
  text: string
}): void {
  if (!canMirrorLaunchDraftToNativeChat(args.text) || !isNativeChatSupportedAgent(args.agent)) {
    return
  }
  useAppStore.getState().seedNativeChatLaunchDraft({
    tabId: args.tabId,
    agent: args.agent,
    text: args.text,
    createdAt: Date.now()
  })
}

export function deliverLaunchPromptToAgentTab(args: {
  tabId: string
  agent: TuiAgent
  content: string
  submit: boolean
  forcePaste: boolean
  timeoutMs?: number
  onTimeout?: () => void
  /** The paste was written without ever observing the agent's composer. */
  onUnconfirmedDelivery?: () => void
  /** The launch pane's PTY once its agent started; the chat copy is seeded only then. */
  launchPty?: Promise<string | null>
}): Promise<boolean> {
  const { tabId, agent, content, submit, forcePaste, timeoutMs, onTimeout, onUnconfirmedDelivery } =
    args
  const shouldSeed =
    submit === true && content.trim().length > 0 && isNativeChatSupportedAgent(agent)
  let seeded = false
  const seedChatCopy = (): void => {
    if (shouldSeed) {
      seeded = true
      useAppStore.getState().seedNativeChatLaunchPrompt({
        tabId,
        agent,
        text: content,
        createdAt: Date.now()
      })
    } else if (submit !== true) {
      // Unsubmitted TUI input is otherwise invisible in chat; seed its composer copy.
      seedNativeChatLaunchDraftForAgentTab({ tabId, agent, text: content })
    }
  }
  // Chained ahead of the paste's own wait on the gate, so the copy always precedes the send.
  const launchPty = args.launchPty?.then((ptyId) => {
    if (ptyId) {
      seedChatCopy()
    }
    return ptyId
  })
  if (!launchPty) {
    seedChatCopy()
  }

  // Native-prefill agents already received the draft; paste returning false must not flag their seeded bubble as failed.
  const deliversViaNativePrefill = agentDeliversDraftViaNativePrefill(agent, forcePaste)

  return pasteDraftWhenAgentReady({
    tabId,
    content,
    agent,
    submit,
    forcePaste,
    timeoutMs,
    onTimeout,
    onUnconfirmedDelivery,
    ...(launchPty ? { launchPty } : {})
  }).then(
    (delivered) => {
      if (seeded && !delivered && !deliversViaNativePrefill) {
        useAppStore.getState().markNativeChatLaunchPromptFailed(tabId)
      }
      return delivered || deliversViaNativePrefill
    },
    (error) => {
      if (seeded && !deliversViaNativePrefill) {
        useAppStore.getState().markNativeChatLaunchPromptFailed(tabId)
      }
      throw error
    }
  )
}
