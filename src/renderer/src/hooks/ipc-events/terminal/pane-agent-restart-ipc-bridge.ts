import { useAppStore } from '../../../store/index'
import {
  rememberRunningPaneAgents,
  restartPaneAgent
} from '@/lib/agent-session/resume/pane-agent-restart'
import type { PaneAgentRestartResult } from '../../../../../shared/native-chat/agent-presence/pane-agent-restart-contract'

/** Answers a paired client's request to restart a pane's agent, and remembers what each agent ran with. */
export function registerPaneAgentRestartIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    useAppStore.subscribe((state, previous) => {
      if (state.agentStatusByPaneKey !== previous.agentStatusByPaneKey) {
        rememberRunningPaneAgents(state, previous.agentStatusByPaneKey)
      }
    })
  )
  unsubs.push(
    window.api.ui.onRequestPaneAgentRestart(({ requestId, ...request }) => {
      let result: PaneAgentRestartResult = { ok: false, reason: 'failed' }
      try {
        result = restartPaneAgent(request)
      } finally {
        // Why: main holds the caller's RPC open until this reply, so a throw must still answer.
        window.api.ui.replyPaneAgentRestart({ requestId, result })
      }
    })
  )
}
