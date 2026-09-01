import { agentDeliversDraftViaNativePrefill } from '@/lib/agent-native-draft-prefill'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { canMirrorLaunchDraftToNativeChat } from '@/lib/native-chat-launch-draft-mirrorability'
import { isNativeChatSupportedAgent } from '@/lib/native-chat-supported-agent'
import { resolveNativeChatBaseAgent } from '@/lib/native-chat-base-agent'
import { useAppStore } from '@/store'
import { resolveTuiAgentConfig } from '../../../shared/custom-tui-agents'
import type { TuiAgent } from '../../../shared/types'

/** Seed the chat-composer copy of launch context that reaches only the TUI
 *  input (argv prefill or startup paste). No-op for agents without a
 *  native-chat renderer, or for text `canMirrorLaunchDraftToNativeChat`
 *  rejects — the same predicate that decides whether the tab opens in chat. */
export function seedNativeChatLaunchDraftForAgentTab(args: {
  tabId: string
  agent: TuiAgent
  text: string
}): void {
  // Seed under the base harness: the chat view resolves panes to a built-in id,
  // and the composer only adopts a draft whose agent matches that resolution.
  const chatAgent = resolveNativeChatBaseAgent(args.agent, useAppStore.getState().settings ?? {})
  if (!canMirrorLaunchDraftToNativeChat(args.text) || !isNativeChatSupportedAgent(chatAgent)) {
    return
  }
  useAppStore.getState().seedNativeChatLaunchDraft({
    tabId: args.tabId,
    agent: chatAgent,
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
}): Promise<boolean> {
  const { tabId, agent, content, submit, forcePaste, timeoutMs, onTimeout } = args
  const promptDeliverySettings = useAppStore.getState().settings
  // Seed under the base harness (see seedNativeChatLaunchDraftForAgentTab); the
  // TUI-side paste below keeps the requested id.
  const chatAgent = resolveNativeChatBaseAgent(agent, promptDeliverySettings ?? {})
  const shouldSeed =
    submit === true && content.trim().length > 0 && isNativeChatSupportedAgent(chatAgent)

  if (shouldSeed) {
    useAppStore.getState().seedNativeChatLaunchPrompt({
      tabId,
      agent: chatAgent,
      text: content,
      createdAt: Date.now()
    })
  } else if (submit !== true) {
    // Why: an unsubmitted draft lives only in the TUI input buffer; seed the
    // chat-composer copy so the context isn't invisible in the GUI view.
    seedNativeChatLaunchDraftForAgentTab({ tabId, agent, text: content })
  }

  // Why: native-prefill agents (claude/openclaude etc.) get the prompt at launch,
  // so pasteDraftWhenAgentReady returns false without pasting. That is a successful
  // native delivery, not a failure — don't flag the seeded bubble in that case.
  // Resolve the base config so a custom-based agent inherits its prefill behavior.
  const deliversViaNativePrefill = agentDeliversDraftViaNativePrefill(
    resolveTuiAgentConfig(
      agent,
      promptDeliverySettings?.customTuiAgents,
      promptDeliverySettings?.deletedCustomTuiAgents
    ),
    forcePaste
  )

  return pasteDraftWhenAgentReady({
    tabId,
    content,
    agent,
    submit,
    forcePaste,
    timeoutMs,
    onTimeout
  }).then(
    (delivered) => {
      if (shouldSeed && !delivered && !deliversViaNativePrefill) {
        useAppStore.getState().markNativeChatLaunchPromptFailed(tabId)
      }
      return delivered || deliversViaNativePrefill
    },
    (error) => {
      if (shouldSeed && !deliversViaNativePrefill) {
        useAppStore.getState().markNativeChatLaunchPromptFailed(tabId)
      }
      throw error
    }
  )
}
