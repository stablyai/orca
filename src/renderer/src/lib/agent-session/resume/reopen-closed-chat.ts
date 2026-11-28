import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import { adoptAgentSessionLaunchVerdict } from '../launch/routing/agent-session-launch-plan'
import { beginStructuredAgentSessionProvisionalLaunch } from '../structured-agent-session-provisional-tab'
import { useAppStore } from '@/store/index'
import type { ClosedChatTabSnapshot } from '@/store/slices/tabs/recently-closed-tabs'

/** Resume the closed chat the way Session History's Resume in New Chat does, then drain on failure. */
export async function resumeClosedChatTab(
  snapshot: ClosedChatTabSnapshot,
  worktreeId: string,
  fallThrough: () => void
): Promise<void> {
  const plan = adoptAgentSessionLaunchVerdict({
    route: 'structured-native-chat',
    requestId: createNonSecureContextUuid(),
    agent: snapshot.agent,
    worktreeId,
    executionHostId: snapshot.executionHostId,
    resumeFrom: { providerSessionId: snapshot.providerSessionId }
  })
  const customTitle = snapshot.customTitle
  const launch = beginStructuredAgentSessionProvisionalLaunch({
    plan,
    hooks: {},
    ...(customTitle
      ? {
          onTabOpenSettled: (tabId) => {
            if (tabId) {
              useAppStore.getState().setTabCustomLabel(tabId, customTitle)
            }
          }
        }
      : {})
  })
  if (!launch) {
    fallThrough()
    return
  }
  const settlement = await launch.settlement
  // A chat that cannot be resumed is drained like an empty snapshot kind.
  if (settlement.kind === 'failed' || settlement.kind === 'terminal') {
    fallThrough()
  }
}
