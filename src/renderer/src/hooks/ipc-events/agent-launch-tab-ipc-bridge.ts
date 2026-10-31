import type { AgentLaunchTabPublishRequest } from '../../../../shared/agent-launch-tab-publication'
import { publishAgentLaunchTab } from '@/lib/agent-launch-tab-publication'
import { applyAgentLaunchPaneVerdict } from '@/lib/agent-launch-pane-verdict-application'
import { keepAgentLaunchTabMainWrote } from '@/lib/agent-launch-tab-main-written'
import { afterLayoutFrame } from '@/runtime/layout-frame-position'

function replyToPublish(
  request: AgentLaunchTabPublishRequest,
  kept?: ReturnType<typeof keepAgentLaunchTabMainWrote>
): void {
  try {
    window.api.ui.replyAgentLaunchTabPublish({
      requestId: request.requestId,
      ...(request.shownByMain
        ? (kept ?? keepAgentLaunchTabMainWrote(request))
        : publishAgentLaunchTab(request))
    })
  } catch (error) {
    window.api.ui.replyAgentLaunchTabPublish({
      requestId: request.requestId,
      error: error instanceof Error ? error.message : 'agent_launch_tab_publish_failed'
    })
  }
}

export function registerAgentLaunchTabIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onPublishAgentLaunchTab((request) => {
      // Retain the exact publication before a verdict can overtake its frame.
      if (request.shownByMain) {
        const kept = keepAgentLaunchTabMainWrote(request)
        afterLayoutFrame(request.shownByMain.frameSeq, () => replyToPublish(request, kept))
      } else {
        replyToPublish(request)
      }
    }),
    window.api.ui.onAgentLaunchPaneVerdict(applyAgentLaunchPaneVerdict)
  )
}
