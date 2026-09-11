import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import { translate } from '@/i18n/i18n'
import { showAgentPasteCredentialPromptToast } from '@/lib/agent-paste-credential-prompt-notice'
import type { AgentDraftDeliveryFailure } from '@/lib/agent-paste-credential-prompt-guard'
import type { TuiAgent } from '../../../shared/tui-agent'

/**
 * Notice for a post-launch paste that never landed — a stalled readiness wait
 * would otherwise drop the user's text silently.
 *
 * Why it takes the failure: the two reasons want different telemetry. Reporting a
 * credential refusal as `paste_readiness_timeout` is the same lie the reason argument
 * exists to prevent.
 *
 * `wasNotified()` reports whether the user already heard about it, so a
 * deferred caller can suppress a duplicate toast.
 */
export function createPasteUndeliveredNotice(args: {
  worktreeId: string
  tabId: string
  agent: TuiAgent
  submitted: boolean
}): { onUndelivered: (failure: AgentDraftDeliveryFailure) => void; wasNotified: () => boolean } {
  let notified = false
  return {
    wasNotified: () => notified,
    onUndelivered: (failure) => {
      const state = useAppStore.getState()
      const currentTab = (state.tabsByWorktree[args.worktreeId] ?? []).find(
        (tab) => tab.id === args.tabId
      )
      if (currentTab?.ptyId === null) {
        // Why: PTY never spawned = genuine launch failure; stay silent so the caller emits the sole notice.
        return
      }
      const navigatedAway = !currentTab || state.activeWorktreeId !== args.worktreeId
      if (navigatedAway && failure !== 'credential-prompt') {
        // Why: user cancelled (closed tab / switched worktrees); mark notified so the deferred caller suppresses its toast too.
        notified = true
        return
      }
      notified = true
      if (failure === 'credential-prompt') {
        // Why this one ignores the cancel suppression: navigating away is evidence the user stopped
        // caring about a stalled readiness wait, but it is not consent to lose a prompt the guard
        // withheld. Suppressing here is the one path on which a credential refusal — including a
        // false positive — disappears with no toast, no fallback and no record.
        showAgentPasteCredentialPromptToast(args.agent, args.submitted)
        return
      }
      toast.message(
        translate(
          'auto.lib.launch.agent.in.new.tab.a5a1f7033f',
          "Your {{value0}} wasn't sent — paste it once the agent is ready.",
          { value0: args.submitted ? 'prompt' : 'notes' }
        )
      )
      track('agent_error', {
        error_class: 'paste_readiness_timeout',
        agent_kind: tuiAgentToAgentKind(args.agent)
      })
    }
  }
}
