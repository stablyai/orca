import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import { translate } from '@/i18n/i18n'
import type { TuiAgent } from '../../../shared/tui-agent'

/** Report otherwise-silent lost launch text; wasNotified lets deferred callers suppress duplicate toasts. */
export function createPasteReadinessTimeoutNotice(args: {
  worktreeId: string
  tabId: string
  agent: TuiAgent
  submitted: boolean
}): { onTimeout: () => void; wasNotified: () => boolean } {
  let notified = false
  return {
    wasNotified: () => notified,
    onTimeout: () => {
      const state = useAppStore.getState()
      const currentTab = (state.tabsByWorktree[args.worktreeId] ?? []).find(
        (tab) => tab.id === args.tabId
      )
      if (currentTab?.ptyId === null) {
        // Why: PTY never spawned = genuine launch failure; stay silent so the caller emits the sole notice.
        return
      }
      if (!currentTab || state.activeWorktreeId !== args.worktreeId) {
        // Why: user cancelled (closed tab / switched worktrees); mark notified so the deferred caller suppresses its toast too.
        notified = true
        return
      }
      toast.message(
        args.submitted
          ? translate(
              'agentLaunch.pasteTimeout.prompt',
              "Your prompt wasn't sent — paste it once the agent is ready."
            )
          : translate(
              'agentLaunch.pasteTimeout.notes',
              "Your notes weren't sent — paste them once the agent is ready."
            )
      )
      notified = true
      track('agent_error', {
        error_class: 'paste_readiness_timeout',
        agent_kind: tuiAgentToAgentKind(args.agent)
      })
    }
  }
}
