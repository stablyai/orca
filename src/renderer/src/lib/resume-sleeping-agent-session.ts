import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import { resolveAgentStartupTarget, type AgentStartupTarget } from '@/lib/agent-startup-target'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../../shared/types'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import { translate } from '@/i18n/i18n'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-types'

function getResumeLaunchContext(worktreeId: string): {
  startupTarget: AgentStartupTarget
} {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(worktreeId)
  const repo = worktree ? (state.repos.find((entry) => entry.id === worktree.repoId) ?? null) : null
  const projectRuntime = repo?.connectionId
    ? undefined
    : getLocalProjectExecutionRuntimeContext(state, worktreeId)
  const startupTarget = resolveAgentStartupTarget({
    host: {
      connectionId: repo?.connectionId ?? null,
      executionHostId: worktree?.hostId ?? repo?.executionHostId,
      path: worktree?.path ?? null
    },
    worktreePath: worktree?.path ?? null,
    projectRuntime,
    terminalWindowsShell: state.settings?.terminalWindowsShell
  })
  return {
    startupTarget
  }
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
  const { startupTarget } = getResumeLaunchContext(record.worktreeId)
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
    platform: startupTarget.platform,
    shell: startupTarget.shell
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

function layoutContainsLeaf(
  node: TerminalPaneLayoutNode | null | undefined,
  leafId: string
): boolean {
  if (!node) {
    return false
  }
  if (node.type === 'leaf') {
    return node.leafId === leafId
  }
  return layoutContainsLeaf(node.first, leafId) || layoutContainsLeaf(node.second, leafId)
}

function hasMatchingStablePaneLayout(
  tabId: string,
  leafId: string,
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot | undefined>
): boolean {
  // Why: hibernation intentionally clears the live PTY binding after the pane
  // exits, but the preserved leaf still owns cold-restore for its session.
  return layoutContainsLeaf(terminalLayoutsByTabId[tabId]?.root, leafId)
}

function hasRestorableStablePanePty(
  tab: TerminalTab,
  tabId: string,
  leafId: string,
  ptyIdsByTabId: Record<string, string[] | undefined>,
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot | undefined>
): boolean {
  const layout = terminalLayoutsByTabId[tabId]
  const hasLeafPty = Boolean(layout?.ptyIdsByLeafId?.[leafId])
  const isSingleLeafLayout = layout?.root?.type === 'leaf' && layout.root.leafId === leafId

  return Boolean(
    hasLeafPty || (isSingleLeafLayout && (tab.ptyId || (ptyIdsByTabId[tabId]?.length ?? 0) > 0))
  )
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
    if (!tab || !hasMatchingStablePaneLayout(tabId, stable.leafId, state.terminalLayoutsByTabId)) {
      return false
    }
    if (record.origin !== 'quit' && record.origin !== 'live') {
      return true
    }
    // Why: live/quit captures rely on pane-level cold restore. A preserved
    // leaf without a PTY/session id can repaint scrollback but cannot resume.
    return hasRestorableStablePanePty(
      tab,
      tabId,
      stable.leafId,
      state.ptyIdsByTabId,
      state.terminalLayoutsByTabId
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

  const paneOwnedClaimKeys = new Set(
    worktreeRecords
      .filter((record) => !isInvalidWorktreeActivationRecord(record))
      .filter((record) => recordPaneIsOwnedByPreservedPane(record, state))
      .map(getProviderSessionClaimKey)
  )

  let launched = 0
  for (const record of worktreeRecords) {
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
