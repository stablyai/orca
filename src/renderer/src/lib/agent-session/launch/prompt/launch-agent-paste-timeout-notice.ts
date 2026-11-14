import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { track } from '@/diagnostics/telemetry/telemetry'
import { tuiAgentToAgentKind } from '../../../../../../shared/agent-kind'
import { translate } from '@/i18n/i18n'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'

/** Report otherwise-silent lost launch text; wasNotified lets deferred callers suppress duplicate toasts. */
export function createPasteReadinessTimeoutNotice(args: {
  worktreeId: string
  tabId: string
  agent: TuiAgent
  submitted: boolean
  /** Text the user typed that only lives here; the toast offers it back instead of losing it. */
  droppedText?: string
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
      if (!currentTab || (state.activeWorktreeId !== args.worktreeId && !args.droppedText)) {
        // Why: user cancelled (closed tab / switched worktrees); mark notified so the deferred caller suppresses its toast too.
        notified = true
        return
      }
      toast.message(
        translate(
          'auto.lib.launch.agent.in.new.tab.a5a1f7033f',
          "Your {{value0}} wasn't sent — paste it once the agent is ready.",
          { value0: args.submitted ? 'prompt' : 'notes' }
        ),
        args.droppedText ? copyDroppedTextAction(args.droppedText) : undefined
      )
      notified = true
      track('agent_error', {
        error_class: 'paste_readiness_timeout',
        agent_kind: tuiAgentToAgentKind(args.agent)
      })
    }
  }
}

function copyDroppedTextAction(text: string): { action: { label: string; onClick: () => void } } {
  return {
    action: {
      label: translate('menu.copy', 'Copy'),
      onClick: () => {
        void window.api.ui.writeClipboardText(text)
      }
    }
  }
}
