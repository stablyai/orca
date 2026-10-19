import { agentDeliversDraftViaNativePrefill } from '@/lib/agent-native-draft-prefill'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { canMirrorLaunchDraftToNativeChat } from '@/lib/native-chat-launch-draft-mirrorability'
import { isNativeChatSupportedAgent } from '@/lib/native-chat-supported-agent'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../shared/tui-agent'

/** Seed the chat-composer copy of launch context that reaches only the TUI
 *  input (argv prefill or startup paste). No-op for agents without a
 *  native-chat renderer, or for text `canMirrorLaunchDraftToNativeChat`
 *  rejects — the same predicate that decides whether the tab opens in chat. */
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
      // Why: an unsubmitted draft lives only in the TUI input buffer; seed the
      // chat-composer copy so the context isn't invisible in the GUI view.
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

  // Why: native-prefill agents (claude/openclaude etc.) get the prompt at launch,
  // so pasteDraftWhenAgentReady returns false without pasting. That is a successful
  // native delivery, not a failure — don't flag the seeded bubble in that case.
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
