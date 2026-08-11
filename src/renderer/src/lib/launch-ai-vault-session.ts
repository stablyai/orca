import { useAppStore } from '@/store'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import { translate } from '@/i18n/i18n'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  createWebRuntimeAgentSessionTerminal,
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
  cwd?: string
  draftPrompt?: string
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
    const runtimeSessionArgs = {
      worktreeId: args.worktreeId,
      environmentId: runtimeEnvironmentId,
      ...(targetGroupId ? { targetGroupId } : {}),
      agentSessionKind: 'resume' as const,
      launchAgent: args.agent,
      command: args.command,
      ...(args.cwd ? { cwd: args.cwd } : {}),
      ...(args.env ? { env: args.env } : {}),
      ...(args.envToDelete ? { envToDelete: args.envToDelete } : {}),
      ...(args.launchConfig ? { launchConfig: args.launchConfig } : {}),
      ...(args.providerSession ? { providerSession: args.providerSession } : {}),
      ...(args.launchConfig ? { agentArgs: args.launchConfig.agentArgs } : {}),
      activate: true
    }
    const runtimeLaunch = args.draftPrompt
      ? createWebRuntimeAgentSessionTerminal({
          ...runtimeSessionArgs,
          promptDelivery: 'draft',
          promptDeliveryOwner: 'client',
          agent: args.agent,
          promptAfterReady: args.draftPrompt,
          submitPrompt: false,
          forcePromptPaste: false
        }).then((result) =>
          result.outcome.status === 'failed' || result.promptDelivered
            ? result.outcome
            : {
                status: 'failed' as const,
                message: translate(
                  'auto.lib.launch.agent.in.new.tab.a5a1f7033f',
                  "Your {{value0}} wasn't sent — paste it once the agent is ready.",
                  { value0: 'draft' }
                )
              }
        )
      : createWebRuntimeSessionTerminal(runtimeSessionArgs)
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

  const tab = args.cwd
    ? store.createTab(args.worktreeId, targetGroupId, undefined, { startupCwd: args.cwd })
    : store.createTab(args.worktreeId, targetGroupId)
  store.queueTabStartupCommand(tab.id, {
    command: args.command,
    ...(args.draftPrompt ? { draftPrompt: args.draftPrompt } : {}),
    ...(args.env ? { env: args.env } : {}),
    ...(args.envToDelete ? { envToDelete: args.envToDelete } : {}),
    ...(args.launchConfig ? { launchConfig: args.launchConfig, launchAgent: args.agent } : {}),
    ...(args.providerSession ? { resumeProviderSession: args.providerSession } : {}),
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
