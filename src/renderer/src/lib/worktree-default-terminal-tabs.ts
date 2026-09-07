import type {
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch
} from '../../../shared/worktree/launch-types'
import { agentKindToTuiAgent } from '../../../shared/agent-kind'
import { initialAgentTabViewModeProps } from './native-chat-initial-view-mode'
import { getConnectionId } from '@/lib/connection-context'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { seedNativeChatAppliedSessionOptions } from '@/components/native-chat/native-chat-session-option-cache'
import type {
  InitialTerminalOptions,
  WorktreeActivationStore
} from '@/lib/worktree-activation-store-contract'
import {
  draftViewModeProps,
  resolveStartupLaunchDraftText,
  type WorktreeStartupPayload
} from '@/lib/worktree-startup-payload'
import {
  queueSetupAndIssueCommands,
  type IssueCommandLaunch
} from '@/lib/worktree-setup-issue-command-queue'

export function applyDefaultTerminalTabs(
  store: WorktreeActivationStore,
  worktreeId: string,
  startup: WorktreeStartupPayload | undefined,
  setup: WorktreeSetupLaunch | undefined,
  issueCommand: IssueCommandLaunch | undefined,
  defaultTabs: WorktreeDefaultTabsLaunch | undefined,
  wrappedSetupCommandStr: string | undefined,
  opts: InitialTerminalOptions | undefined
): string | null {
  if (!defaultTabs || store.defaultTerminalTabsAppliedByWorktreeId[worktreeId]) {
    return null
  }
  store.markDefaultTerminalTabsApplied(worktreeId)
  if (defaultTabs.tabs.length === 0) {
    return null
  }

  let firstTabId: string | null = null
  for (const [index, template] of defaultTabs.tabs.entries()) {
    const isStartupTab = index === 0 && startup !== undefined
    const launchAgent =
      isStartupTab && startup?.launchAgent
        ? startup.launchAgent
        : isStartupTab && startup?.telemetry
          ? (agentKindToTuiAgent(startup.telemetry.agent_kind) ?? undefined)
          : undefined
    const tab = store.createTab(worktreeId, undefined, undefined, {
      pendingActivationSpawn: true,
      recordInteraction: false,
      ...(launchAgent
        ? {
            launchAgent,
            ...initialAgentTabViewModeProps(store.settings ?? null, {
              agent: launchAgent,
              ...draftViewModeProps(
                isStartupTab ? resolveStartupLaunchDraftText(startup) : undefined
              ),
              nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
                getConnectionId(worktreeId)
              )
            })
          }
        : {}),
      ...(opts?.activateCreatedTabs === false ? { activate: false } : {})
    })
    if (index === 0) {
      firstTabId = tab.id
    }
    if (template.title) {
      store.setTabCustomTitle(tab.id, template.title, { recordInteraction: false })
    }
    if (template.color) {
      store.setTabColor(tab.id, template.color)
    }
    const templateCommand = template.command?.trim()
    if (templateCommand && defaultTabs.runCommands && !(index === 0 && startup)) {
      store.queueTabStartupCommand(tab.id, { command: templateCommand })
    }
  }

  if (!firstTabId) {
    return null
  }
  if (opts?.activateCreatedTabs !== false) {
    store.setActiveTab(firstTabId)
  }
  if (startup) {
    const startupAgent =
      startup.launchAgent ??
      (startup.telemetry
        ? (agentKindToTuiAgent(startup.telemetry.agent_kind) ?? undefined)
        : undefined)
    if (startupAgent) {
      seedNativeChatAppliedSessionOptions(firstTabId, startupAgent, startup.sessionOptions)
    }
    store.queueTabStartupCommand(firstTabId, startup)
  }
  queueSetupAndIssueCommands(
    store,
    worktreeId,
    firstTabId,
    setup,
    issueCommand,
    wrappedSetupCommandStr,
    opts
  )
  return firstTabId
}
