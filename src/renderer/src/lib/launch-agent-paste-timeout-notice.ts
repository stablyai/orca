import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import { translate } from '@/i18n/i18n'
import type { TuiAgent } from '../../../shared/tui-agent'
import { showAgentLaunchPromptNotDeliveredNotice } from '@/lib/agent-launch-prompt-not-delivered-notice'

/**
 * Notice for a post-launch paste that never landed — a stalled readiness wait
 * would otherwise drop the user's text silently.
 *
 * `wasNotified()` reports whether the user already heard about it, so a
 * deferred caller can suppress a duplicate toast.
 */
export function createPasteReadinessTimeoutNotice(args: {
  worktreeId: string
  tabId: string
  agent: TuiAgent
  submitted: boolean
  /** The text that was not delivered, handed back through the notice's Copy action. */
  content: string
}): {
  onTimeout: () => void
  wasNotified: () => boolean
  /** Reports the paste's outcome, telling the user about any undelivered one, not only a timeout. */
  settle: (
    delivered: boolean,
    onDelivered?: () => void
  ) => { delivered: boolean; failureNotified: boolean }
} {
  let notified = false
  const onTimeout = (): void => {
    if (notified) {
      return
    }
    notifyUndelivered()
  }
  return {
    wasNotified: () => notified,
    onTimeout,
    settle: (delivered, onDelivered) => {
      if (delivered) {
        onDelivered?.()
      } else {
        onTimeout()
      }
      return { delivered, failureNotified: !delivered && notified }
    }
  }
  function notifyUndelivered(): void {
    const state = useAppStore.getState()
    const currentTab = (state.tabsByWorktree[args.worktreeId] ?? []).find(
      (tab) => tab.id === args.tabId
    )
    if (currentTab?.ptyId === null) {
      // Why: PTY never spawned = genuine launch failure; stay silent so the caller emits the sole notice.
      return
    }
    notified = true
    if (!currentTab) {
      // Why: the user closed the tab; mark notified so the deferred caller suppresses its toast too.
      return
    }
    if (args.submitted) {
      // Why a persistent Copy action, even from another worktree: the notice holds the only copy.
      showAgentLaunchPromptNotDeliveredNotice({ agent: args.agent, prompt: args.content })
      return
    }
    toast.message(
      translate(
        'auto.lib.launch.agent.in.new.tab.a5a1f7033f',
        "Your {{value0}} wasn't sent — paste it once the agent is ready.",
        { value0: 'notes' }
      )
    )
    track('agent_error', {
      error_class: 'paste_readiness_timeout',
      agent_kind: tuiAgentToAgentKind(args.agent)
    })
  }
}
