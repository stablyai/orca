import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type { AgentStartupPlan } from '../../../../../../shared/agent-launch/startup/tui-agent-startup'
import {
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { StartupDraftReceipt } from '../../../../../../shared/worktree/creation/startup-draft-receipt'
import type { ActivateAndRevealResult } from '@/lib/workspace/activation/worktree-activation-outcome'
import {
  releaseUnclaimedStartupDraft,
  waitForStartupDraftOutcome
} from '@/lib/workspace/creation/worktree-startup-draft-recovery'
import { ensureAgentStartupInTerminal } from '@/lib/workspace/creation/new-workspace'
import { seedNativeChatLaunchDraftForAgentTab } from '@/lib/agent-session/launch/prompt/agent-launch-prompt-delivery'

export function completeFolderWorkspaceStartup(args: {
  activation: ActivateAndRevealResult | false
  worktreeId: string
  hostStartupTabId?: string
  hostStartsTerminal: boolean
  launchFailed: boolean
  structuredLaunch: boolean
  quickAgent: TuiAgent | null
  launchDraftPrompt: string | null
  runtimeEnvironmentId: string | null
  startupPlan: AgentStartupPlan | null
  hostId: ExecutionHostId
  startupDraftReceipt?: StartupDraftReceipt
}): void {
  const {
    activation,
    worktreeId,
    hostStartupTabId,
    hostStartsTerminal,
    launchFailed,
    structuredLaunch,
    quickAgent,
    launchDraftPrompt,
    runtimeEnvironmentId,
    startupPlan,
    startupDraftReceipt
  } = args
  const hostId = runtimeEnvironmentId ? toRuntimeExecutionHostId(runtimeEnvironmentId) : args.hostId
  if (launchFailed) {
    if (!hostStartsTerminal) {
      releaseUnclaimedStartupDraft(hostId, startupDraftReceipt)
    }
    return
  }
  const draftTabId = hostStartsTerminal
    ? hostStartupTabId
    : activation !== false
      ? activation.primaryTabId
      : undefined
  const seedAndDeliver = (): void => {
    if (!structuredLaunch && quickAgent && launchDraftPrompt && draftTabId) {
      // TUI prefill needs a separate chat-composer copy to remain visible after switching views.
      seedNativeChatLaunchDraftForAgentTab({
        tabId: draftTabId,
        agent: quickAgent,
        text: launchDraftPrompt
      })
    }
    if (
      !runtimeEnvironmentId &&
      !structuredLaunch &&
      startupPlan &&
      (startupPlan.followupPrompt || startupPlan.draftPrompt) &&
      activation !== false
    ) {
      void ensureAgentStartupInTerminal({
        worktreeId: worktreeId,
        primaryTabId: activation.primaryTabId,
        startup: startupPlan
      })
    }
  }
  if (startupDraftReceipt) {
    void waitForStartupDraftOutcome(hostId, startupDraftReceipt).then((outcome) => {
      if (outcome === 'started') {
        seedAndDeliver()
      }
    })
  } else {
    seedAndDeliver()
  }
}
