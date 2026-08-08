import { useAppStore } from '@/store'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive
} from '@/runtime/web-runtime-session'
import { callRuntimeRpc, hasRuntimeRpcErrorCode } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type { AiVaultAgent } from '../../../shared/ai-vault-types'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../shared/agent-session-resume'
import { isResumableTuiAgent } from '../../../shared/agent-session-resume'
import type { TabSplitDirection } from '@/store/slices/tabs'
import type { WebRuntimeTerminalCreateOutcome } from '@/runtime/web-runtime-session'
import type { RuntimeEnsureAgentSessionResult } from '../../../shared/agent-session-host-authority'

export type LaunchAiVaultSessionInNewTabResult =
  | { tabId: string; groupId?: string }
  | { tabId: null; groupId?: string; runtimeLaunch: Promise<WebRuntimeTerminalCreateOutcome> }

export function launchAiVaultSessionInNewTab(args: {
  agent: AiVaultAgent
  worktreeId: string
  command: string
  cwd?: string
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
      ...(args.cwd ? { cwd: args.cwd } : {}),
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

  const launchLegacyLocalTab = (): { tabId: string; groupId?: string } => {
    const tab = store.createTab(args.worktreeId, targetGroupId, undefined, {
      ...(args.cwd ? { startupCwd: args.cwd } : {}),
      launchAgent: args.agent
    })
    store.queueTabStartupCommand(tab.id, {
      command: args.command,
      ...(args.env ? { env: args.env } : {}),
      ...(args.envToDelete ? { envToDelete: args.envToDelete } : {}),
      ...(args.launchConfig ? { launchConfig: args.launchConfig } : {}),
      ...(args.providerSession ? { resumeProviderSession: args.providerSession } : {}),
      launchAgent: args.agent,
      telemetry: {
        agent_kind: tuiAgentToAgentKind(args.agent),
        launch_source: 'sidebar',
        request_kind: 'resume'
      }
    })
    store.setActiveTabType('terminal')

    const fresh = useAppStore.getState()
    const termIds = (fresh.tabsByWorktree[args.worktreeId] ?? []).map((item) => item.id)
    const editorIds = fresh.openFiles
      .filter((file) => file.worktreeId === args.worktreeId)
      .map((file) => file.id)
    const browserIds = (fresh.browserTabsByWorktree?.[args.worktreeId] ?? []).map((item) => item.id)
    const base = reconcileTabOrder(
      fresh.tabBarOrderByWorktree[args.worktreeId],
      termIds,
      editorIds,
      browserIds
    )
    const order = base.filter((id) => id !== tab.id)
    order.push(tab.id)
    fresh.setTabBarOrder(args.worktreeId, order)

    return { tabId: tab.id, ...(targetGroupId ? { groupId: targetGroupId } : {}) }
  }

  if (args.providerSession && isResumableTuiAgent(args.agent)) {
    const resolvedTargetGroupId = targetGroupId
    const runtimeLaunch = callRuntimeRpc<RuntimeEnsureAgentSessionResult>(
      { kind: 'local' },
      'terminal.ensureAgentSession',
      {
        kind: 'explicit',
        worktree: toRuntimeWorktreeSelector(args.worktreeId),
        agent: args.agent,
        providerSession: args.providerSession,
        ...(args.launchConfig?.ompResumeFilePath
          ? { ompResumeFilePath: args.launchConfig.ompResumeFilePath }
          : {}),
        ...(args.launchConfig ? { agentArgs: args.launchConfig.agentArgs } : {}),
        command: args.command,
        ...(args.env ? { env: args.env } : {}),
        ...(args.envToDelete ? { envToDelete: args.envToDelete } : {}),
        ...(args.launchConfig ? { launchConfig: args.launchConfig } : {}),
        presentation: 'focused'
      }
    ).then(
      ({ terminal }) => {
        if (resolvedTargetGroupId && terminal.tabId) {
          useAppStore.getState().moveUnifiedTabToGroup(terminal.tabId, resolvedTargetGroupId)
        }
        useAppStore.getState().setActiveTabType('terminal')
        return { status: 'created' as const }
      },
      (error: unknown) => {
        if (hasRuntimeRpcErrorCode(error, 'agent_session_legacy_required')) {
          launchLegacyLocalTab()
          return { status: 'created' as const }
        }
        return {
          status: 'failed' as const,
          message: error instanceof Error ? error.message : String(error)
        }
      }
    )
    return {
      tabId: null,
      ...(targetGroupId ? { groupId: targetGroupId } : {}),
      runtimeLaunch
    }
  }

  return launchLegacyLocalTab()
}
