import type {
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch
} from '../../../shared/worktree/launch-types'
import { agentKindToTuiAgent } from '../../../shared/agent-kind'
import { seedNativeChatAppliedSessionOptions } from '@/components/native-chat/native-chat-session-option-cache'
import type {
  InitialTerminalOptions,
  WorktreeActivationStore
} from '@/lib/worktree-activation-store-contract'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'
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
    const templateCommand = template.command?.trim()
    const pendingStartup = isStartupTab
      ? startup
      : templateCommand && defaultTabs.runCommands
        ? { command: templateCommand }
        : undefined
    const tab = store.createTab(worktreeId, undefined, undefined, {
      pendingActivationSpawn: true,
      recordInteraction: false,
      ...(launchAgent ? { launchAgent } : {}),
      // Why: an automatic tab is shown, not chosen; only an activated create would record focus.
      ...(opts?.activateCreatedTabs === false ? { activate: false } : { recordFocus: false }),
      ...(pendingStartup ? { pendingStartup } : {})
    })
    if (index === 0) {
      firstTabId = tab.id
    }
    if (isStartupTab && launchAgent) {
      seedNativeChatAppliedSessionOptions(tab.id, launchAgent, startup.sessionOptions)
    }
    if (template.title) {
      store.setTabCustomTitle(tab.id, template.title, { recordInteraction: false })
    }
    if (template.color) {
      store.setTabColor(tab.id, template.color)
    }
  }

  if (!firstTabId) {
    return null
  }
  if (opts?.activateCreatedTabs !== false) {
    store.setActiveTab(firstTabId, { recordFocus: false })
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
