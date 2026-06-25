import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { TerminalTab } from '../../../shared/types'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import { translate } from '@/i18n/i18n'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-types'

function getResumeLaunchPlatform(worktreeId: string): NodeJS.Platform {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(worktreeId)
  const repo = worktree ? state.repos.find((entry) => entry.id === worktree.repoId) : null
  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, worktreeId)
  if (projectRuntime?.status === 'repair-required') {
    return projectRuntime.repair.preferredRuntime.kind === 'wsl' ? 'linux' : CLIENT_PLATFORM
  }
  if (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl') {
    return 'linux'
  }
  if (repo?.connectionId || (worktree?.path && isWslUncPath(worktree.path))) {
    return 'linux'
  }
  return CLIENT_PLATFORM
}

function appendTabToWorktreeOrder(worktreeId: string, tabId: string): void {
  const state = useAppStore.getState()
  const termIds = (state.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
  const editorIds = state.openFiles
    .filter((file) => file.worktreeId === worktreeId)
    .map((f) => f.id)
  const browserIds = (state.browserTabsByWorktree?.[worktreeId] ?? []).map((tab) => tab.id)
  const base = reconcileTabOrder(
    state.tabBarOrderByWorktree[worktreeId],
    termIds,
    editorIds,
    browserIds
  )
  const order = base.filter((id) => id !== tabId)
  order.push(tabId)
  state.setTabBarOrder(worktreeId, order)
}

function launchSleepingAgentSession(record: SleepingAgentSessionRecord): boolean {
  const state = useAppStore.getState()
  const launchConfig = record.launchConfig
  const startupPlan = buildAgentResumeStartupPlan({
    agent: record.agent,
    providerSession: record.providerSession,
    cmdOverrides: state.settings?.agentCmdOverrides ?? {},
    agentArgs:
      launchConfig !== undefined
        ? launchConfig.agentArgs
        : resolveTuiAgentLaunchArgs(record.agent, state.settings?.agentDefaultArgs),
    agentEnv:
      launchConfig !== undefined
        ? launchConfig.agentEnv
        : resolveTuiAgentLaunchEnv(record.agent, state.settings?.agentDefaultEnv),
    ...(launchConfig?.agentCommand ? { agentCommand: launchConfig.agentCommand } : {}),
    platform: getResumeLaunchPlatform(record.worktreeId)
  })
  if (!startupPlan) {
    toast.error(
      translate(
        'auto.lib.resume.sleeping.agent.session.f235f604fd',
        'This agent session cannot be resumed.'
      )
    )
    return false
  }

  const tab = state.createTab(record.worktreeId, undefined, undefined, {
    launchAgent: record.agent
  })
  state.queueTabStartupCommand(tab.id, {
    command: startupPlan.launchCommand,
    ...(startupPlan.env ? { env: startupPlan.env } : {}),
    launchConfig: startupPlan.launchConfig,
    launchAgent: record.agent,
    ...(startupPlan.startupCommandDelivery
      ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
      : {}),
    showSessionRestoredBanner: true,
    telemetry: {
      agent_kind: tuiAgentToAgentKind(record.agent),
      launch_source: 'sidebar',
      request_kind: 'resume'
    }
  })
  state.clearSleepingAgentSession(record.paneKey)
  state.setActiveTabType('terminal')
  appendTabToWorktreeOrder(record.worktreeId, tab.id)
  return true
}

function getProviderSessionClaimKey(record: SleepingAgentSessionRecord): string {
  return [
    record.worktreeId,
    record.agent,
    record.providerSession.key,
    record.providerSession.id
  ].join('\0')
}

function getLegacyPaneTabId(record: SleepingAgentSessionRecord): string | null {
  const legacy = parseLegacyNumericPaneKey(record.paneKey)
  if (!legacy || (record.tabId && record.tabId !== legacy.tabId)) {
    return null
  }
  return record.tabId ?? legacy.tabId
}

function getLegacyProviderSessionKeysForTab(
  state: ReturnType<typeof useAppStore.getState>,
  worktreeId: string,
  tabId: string
): Set<string> {
  const keys = new Set<string>()
  for (const record of Object.values(state.sleepingAgentSessionsByPaneKey)) {
    if (record.worktreeId === worktreeId && getLegacyPaneTabId(record) === tabId) {
      keys.add(getProviderSessionClaimKey(record))
    }
  }
  return keys
}

function hasRestorableLegacyTabPty(
  tab: TerminalTab,
  ptyIdsByTabId: Record<string, string[] | undefined>
): boolean {
  return Boolean(tab.ptyId) || (ptyIdsByTabId[tab.id]?.length ?? 0) > 0
}

function hasMatchingStablePaneLayout(
  tabId: string,
  leafId: string,
  terminalLayoutsByTabId: ReturnType<typeof useAppStore.getState>['terminalLayoutsByTabId']
): boolean {
  const ptyIdsByLeafId = terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId
  return Boolean(ptyIdsByLeafId && Object.hasOwn(ptyIdsByLeafId, leafId))
}

function findSameWorktreeTab(
  worktreeTabs: readonly TerminalTab[],
  tabId: string
): TerminalTab | null {
  return worktreeTabs.find((tab) => tab.id === tabId) ?? null
}

function recordPaneIsOwnedByPreservedPane(
  record: SleepingAgentSessionRecord,
  state: ReturnType<typeof useAppStore.getState>
): boolean {
  const worktreeTabs = state.tabsByWorktree[record.worktreeId] ?? []
  const stable = parsePaneKey(record.paneKey)
  if (stable) {
    if (record.tabId && record.tabId !== stable.tabId) {
      return false
    }
    const tabId = record.tabId ?? stable.tabId
    const tab = findSameWorktreeTab(worktreeTabs, tabId)
    return Boolean(
      tab && hasMatchingStablePaneLayout(tabId, stable.leafId, state.terminalLayoutsByTabId)
    )
  }

  const tabId = getLegacyPaneTabId(record)
  if (!tabId) {
    return false
  }
  const tab = findSameWorktreeTab(worktreeTabs, tabId)
  const providerKeys = getLegacyProviderSessionKeysForTab(state, record.worktreeId, tabId)
  // Why: legacy numeric pane keys lack leaf identity, so only a preserved
  // tab-level wake hint plus a single provider session is strong enough to
  // claim pane recovery without risking the wrong split-pane session.
  return Boolean(
    tab && hasRestorableLegacyTabPty(tab, state.ptyIdsByTabId) && providerKeys.size === 1
  )
}

function isInvalidWorktreeActivationRecord(record: SleepingAgentSessionRecord): boolean {
  if (record.interrupted === true) {
    return true
  }
  if (!record.origin && record.state === 'done') {
    return true
  }
  return (
    record.state !== 'done' && record.capturedAt - record.updatedAt > AGENT_STATUS_STALE_AFTER_MS
  )
}

export function resumeSleepingAgentSessionsForWorktree(worktreeId: string): number {
  const state = useAppStore.getState()
  const worktreeRecords = Object.values(state.sleepingAgentSessionsByPaneKey)
    .filter((record) => record.worktreeId === worktreeId)
    .sort((a, b) => a.capturedAt - b.capturedAt || a.updatedAt - b.updatedAt)
  const records = worktreeRecords
    // Why: pane-owned captures (#5232/#5626) cover panes that still exist in
    // the restored session. Those panes own their own recovery — warm reattach
    // when the daemon kept the agent alive, or pane-level cold-restore resume.
    .filter((record) => record.origin !== 'quit' && record.origin !== 'live')

  const paneOwnedClaimKeys = new Set(
    worktreeRecords
      .filter((record) => recordPaneIsOwnedByPreservedPane(record, state))
      .map(getProviderSessionClaimKey)
  )

  let launched = 0
  for (const record of records) {
    const claimKey = getProviderSessionClaimKey(record)
    if (isInvalidWorktreeActivationRecord(record)) {
      state.clearSleepingAgentSession(record.paneKey)
      continue
    }
    if (paneOwnedClaimKeys.has(claimKey)) {
      if (!recordPaneIsOwnedByPreservedPane(record, state)) {
        state.clearSleepingAgentSession(record.paneKey)
      }
      continue
    }
    if (launchSleepingAgentSession(record)) {
      launched += 1
      paneOwnedClaimKeys.add(claimKey)
    }
  }
  return launched
}
