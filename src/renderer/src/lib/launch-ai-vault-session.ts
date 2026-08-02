import { useAppStore } from '@/store'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive
} from '@/runtime/web-runtime-session'
import type { AiVaultAgent } from '../../../shared/ai-vault-types'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../shared/agent-session-resume'
import type { TabSplitDirection } from '@/store/slices/tabs'
import type { WebRuntimeTerminalCreateOutcome } from '@/runtime/web-runtime-session'

export type LaunchAiVaultSessionInNewTabResult =
  | { tabId: string; groupId?: string }
  | { tabId: null; groupId?: string; runtimeLaunch: Promise<WebRuntimeTerminalCreateOutcome> }

export function launchAiVaultSessionInNewTab(args: {
  agent: AiVaultAgent
  worktreeId: string
  command: string
  env?: Record<string, string>
  envToDelete?: string[]
  launchConfig?: SleepingAgentLaunchConfig
  providerSession?: AgentProviderSessionMetadata
  targetGroupId?: string
  splitDirection?: TabSplitDirection
}): LaunchAiVaultSessionInNewTabResult {
  const store = useAppStore.getState()
  let targetGroupId = args.targetGroupId
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(store, args.worktreeId)
  if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    const runtimeLaunch = createWebRuntimeSessionTerminal({
      worktreeId: args.worktreeId,
      environmentId: runtimeEnvironmentId,
      ...(targetGroupId ? { targetGroupId } : {}),
      agentSessionKind: 'resume',
      launchAgent: args.agent,
      command: args.command,
      ...(args.env ? { env: args.env } : {}),
      ...(args.envToDelete ? { envToDelete: args.envToDelete } : {}),
      ...(args.launchConfig ? { launchConfig: args.launchConfig } : {}),
      ...(args.providerSession ? { providerSession: args.providerSession } : {}),
      ...(args.launchConfig ? { agentArgs: args.launchConfig.agentArgs } : {}),
      activate: true
    })
    const observedRuntimeLaunch = runtimeLaunch.then((outcome) => {
      if (outcome.status === 'created') {
        useAppStore.getState().setActiveTabType('terminal')
      }
      return outcome
    })
    return {
      tabId: null,
      ...(targetGroupId ? { groupId: targetGroupId } : {}),
      runtimeLaunch: observedRuntimeLaunch
    }
  }

  if (args.splitDirection && targetGroupId) {
    targetGroupId =
      store.createEmptySplitGroup(args.worktreeId, targetGroupId, args.splitDirection) ??
      targetGroupId
  }

  const tab = store.createTab(args.worktreeId, targetGroupId)
  store.queueTabStartupCommand(tab.id, {
    command: args.command,
    ...(args.env ? { env: args.env } : {}),
    ...(args.envToDelete ? { envToDelete: args.envToDelete } : {}),
    ...(args.launchConfig ? { launchConfig: args.launchConfig, launchAgent: args.agent } : {}),
    telemetry: {
      agent_kind: tuiAgentToAgentKind(args.agent),
      launch_source: 'sidebar',
      request_kind: 'resume'
    }
  })
  store.setActiveTabType('terminal')

  const fresh = useAppStore.getState()
  const termIds = (fresh.tabsByWorktree[args.worktreeId] ?? []).map((t) => t.id)
  const editorIds = fresh.openFiles.filter((f) => f.worktreeId === args.worktreeId).map((f) => f.id)
  const browserIds = (fresh.browserTabsByWorktree?.[args.worktreeId] ?? []).map((t) => t.id)
  const base = reconcileTabOrder(
    fresh.tabBarOrderByWorktree[args.worktreeId],
    termIds,
    editorIds,
    browserIds
  )
  const order = base.filter((id) => id !== tab.id)
  order.push(tab.id)
  fresh.setTabBarOrder(args.worktreeId, order)

  return { tabId: tab.id, groupId: targetGroupId }
}
