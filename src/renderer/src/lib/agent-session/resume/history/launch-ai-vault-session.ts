import { useAppStore } from '@/store/index'
import { agentTabLaunchStore } from '@/lib/agent-session/launch/new-tab/launch-agent-execution-context'
import { resolveWorktreeOperationRouteForHost } from '@/lib/workspace/ownership/worktree-operation-route'
import {
  getAiVaultResumeProjectRuntime,
  getAiVaultResumeWorkspacePath
} from './ai-vault-resume-shell'
import { getAiVaultResumePlatform } from './ai-vault-resume-platform'
import { findAiVaultHistoryWorktree } from './ai-vault-history-worktrees'
import { getConnectionIdForWorktreeCopy } from '@/lib/workspace/ownership/connection-owner-resolution'
import { resolveQualifiedWorktreeExecutionOwner } from '@/lib/workspace/ownership/qualified-worktree-execution-owner'
import { isWslUncPath } from '../../../../../../shared/wsl-paths'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { TerminalCreationExecutionFacts } from '@/store/terminals/terminal-contracts'
import { persistAgentLaunchTabOrder } from '@/lib/agent-session/launch/pane/launch-agent-tab-order'
import '@/diagnostics/telemetry/telemetry'
import { tuiAgentToAgentKind } from '../../../../../../shared/agent-kind'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { createWebRuntimeSessionTerminal } from '@/runtime/hosted-terminals/creation/web-runtime-terminal-creation'
import { isWebRuntimeSessionActive } from '@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment'
import type { AiVaultAgent } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { TabSplitDirection } from '@/store/slices/tabs/tabs-slice-contract'
import type { WebRuntimeTerminalCreateOutcome } from '@/runtime/hosted-terminals/creation/terminal-create-contracts'

export type LaunchAiVaultSessionInNewTabResult =
  | { tabId: string }
  | { tabId: null; runtimeLaunch: Promise<WebRuntimeTerminalCreateOutcome> }

export function launchAiVaultSessionInNewTab(args: {
  agent: AiVaultAgent
  worktreeId: string
  workspaceExecutionHostId?: ExecutionHostId
  command: string
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  launchConfig?: SleepingAgentLaunchConfig
  providerSession?: AgentProviderSessionMetadata
  targetGroupId?: string
  splitDirection?: TabSplitDirection
}): LaunchAiVaultSessionInNewTabResult {
  const store = agentTabLaunchStore(useAppStore.getState(), args)
  // Why both paths split: the runtime path used to return first and drop the split (#22791).
  const split =
    args.splitDirection && args.targetGroupId
      ? { sourceGroupId: args.targetGroupId, splitDirection: args.splitDirection }
      : undefined
  const route = args.workspaceExecutionHostId
    ? resolveWorktreeOperationRouteForHost(store, args.worktreeId, args.workspaceExecutionHostId)
    : null
  if (args.workspaceExecutionHostId && !route) {
    throw new Error('The conversation workspace is no longer on its recording host.')
  }
  const runtimeEnvironmentId = args.workspaceExecutionHostId
    ? (route?.runtimeEnvironmentId ?? null)
    : runtimeEnvironmentIdOrLocalUnlessTwin(store, args.worktreeId)
  if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    // Why an empty group first: the paired host creates the tab after a round trip.
    const splitGroupId = split
      ? store.createEmptySplitGroup(args.worktreeId, split.sourceGroupId, split.splitDirection)
      : null
    const targetGroupId = splitGroupId ?? args.targetGroupId
    const runtimeLaunch = createWebRuntimeSessionTerminal(
      {
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
      },
      { notifyFailure: false }
    )
    const observedRuntimeLaunch = runtimeLaunch.then((outcome) => {
      if (outcome.status === 'created') {
        useAppStore.getState().setActiveTabType('terminal', args.worktreeId)
      } else if (splitGroupId) {
        // A refused or failed drop must not leave a blank pane behind.
        useAppStore.getState().closeEmptyGroup(args.worktreeId, splitGroupId)
      }
      return outcome
    })
    return { tabId: null, runtimeLaunch: observedRuntimeLaunch }
  }

  let executionFacts: TerminalCreationExecutionFacts | undefined
  if (args.workspaceExecutionHostId) {
    const worktree = findAiVaultHistoryWorktree(
      store,
      args.worktreeId,
      args.workspaceExecutionHostId
    )
    const connectionId = worktree
      ? resolveQualifiedWorktreeExecutionOwner(
          { [args.worktreeId]: [worktree] },
          store.repos,
          args.worktreeId,
          args.workspaceExecutionHostId
        )?.connectionId
      : getConnectionIdForWorktreeCopy(store, args.worktreeId, args.workspaceExecutionHostId)
    const platform = getAiVaultResumePlatform(store, args.worktreeId, args.workspaceExecutionHostId)
    if (connectionId === undefined) {
      throw new Error('The conversation workspace is no longer on its recording host.')
    }
    const path = getAiVaultResumeWorkspacePath(
      store,
      args.worktreeId,
      args.workspaceExecutionHostId
    )
    executionFacts = {
      hostId: args.workspaceExecutionHostId,
      connectionId,
      platform,
      isRemote: Boolean(connectionId),
      isWsl: Boolean(path && isWslUncPath(path)),
      projectRuntime: getAiVaultResumeProjectRuntime(
        store,
        args.worktreeId,
        args.workspaceExecutionHostId
      )
    }
  }
  const tab = store.createTab(args.worktreeId, args.targetGroupId, undefined, {
    ...(split ? { split } : {}),
    ...(executionFacts ? { executionFacts } : {}),
    ...(args.cwd ? { startupCwd: args.cwd } : {}),
    pendingStartup: {
      command: args.command,
      ...(args.env ? { env: args.env } : {}),
      ...(args.envToDelete ? { envToDelete: args.envToDelete } : {}),
      ...(args.launchConfig ? { launchConfig: args.launchConfig, launchAgent: args.agent } : {}),
      ...(args.providerSession ? { resumeProviderSession: args.providerSession } : {}),
      telemetry: {
        agent_kind: tuiAgentToAgentKind(args.agent),
        launch_source: 'sidebar',
        request_kind: 'resume'
      }
    }
  })
  store.setActiveTabType('terminal', args.worktreeId)

  persistAgentLaunchTabOrder(args.worktreeId, tab.id)

  return { tabId: tab.id }
}
