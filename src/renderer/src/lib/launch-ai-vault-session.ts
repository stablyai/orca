import { useAppStore } from '@/store'
import { persistAgentLaunchTabOrder } from '@/lib/launch-agent-tab-order'
import { insertUnifiedTabAfterAnchor } from '@/lib/unified-tab-anchor-insertion'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { createWebRuntimeSessionTerminal } from '@/runtime/web-runtime-terminal-creation'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import type { AiVaultAgent } from '../../../shared/ai-vault-types'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../shared/agent-session-resume'
import type { TabSplitDirection } from '@/store/slices/tabs'
import type { WebRuntimeTerminalCreateOutcome } from '@/runtime/web-runtime-session-types'

export type LaunchAiVaultSessionInNewTabResult =
  | { tabId: string }
  | { tabId: null; runtimeLaunch: Promise<WebRuntimeTerminalCreateOutcome> }

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
  /** Opens in this tab's slot: the next tab in its group. */
  afterTabId?: string
  /** A chat's switch, whose ordinary spawn admits the resume; set only for a capable host. */
  resumeOrigin?: 'switch'
}): LaunchAiVaultSessionInNewTabResult {
  const store = useAppStore.getState()
  const slot = args.afterTabId
    ? store.unifiedTabsByWorktree[args.worktreeId]?.find((tab) => tab.id === args.afterTabId)
    : undefined
  const sourceGroupId = args.targetGroupId ?? slot?.groupId
  const switchStart = args.resumeOrigin ? { resumeOrigin: args.resumeOrigin } : {}
  // Why both paths split: the runtime path used to return first and drop the split (#22791).
  const split =
    args.splitDirection && args.targetGroupId
      ? { sourceGroupId: args.targetGroupId, splitDirection: args.splitDirection }
      : undefined
  const runtimeEnvironmentId = runtimeEnvironmentIdOrLocalUnlessTwin(store, args.worktreeId)
  if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    // Why an empty group first: the paired host creates the tab after a round trip.
    const splitGroupId = split
      ? store.createEmptySplitGroup(args.worktreeId, split.sourceGroupId, split.splitDirection)
      : null
    const targetGroupId = splitGroupId ?? sourceGroupId
    const runtimeLaunch = createWebRuntimeSessionTerminal(
      {
        worktreeId: args.worktreeId,
        environmentId: runtimeEnvironmentId,
        ...(targetGroupId ? { targetGroupId } : {}),
        ...(args.afterTabId ? { afterTabId: args.afterTabId } : {}),
        ...switchStart,
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

  const tab = store.createTab(args.worktreeId, sourceGroupId, undefined, {
    ...(split ? { split } : {}),
    ...(args.cwd ? { startupCwd: args.cwd } : {}),
    pendingStartup: {
      command: args.command,
      ...(args.env ? { env: args.env } : {}),
      ...(args.envToDelete ? { envToDelete: args.envToDelete } : {}),
      ...(args.launchConfig ? { launchConfig: args.launchConfig, launchAgent: args.agent } : {}),
      ...(args.providerSession ? { resumeProviderSession: args.providerSession } : {}),
      ...(args.resumeOrigin ? { launchAgent: args.agent, ...switchStart } : {}),
      telemetry: {
        agent_kind: tuiAgentToAgentKind(args.agent),
        launch_source: 'sidebar',
        request_kind: 'resume'
      }
    }
  })
  store.setActiveTabType('terminal', args.worktreeId)

  persistAgentLaunchTabOrder(args.worktreeId, tab.id)
  if (slot && !split && (!args.targetGroupId || args.targetGroupId === slot.groupId)) {
    insertUnifiedTabAfterAnchor(args.worktreeId, tab.id, slot.id)
  }

  return { tabId: tab.id }
}
