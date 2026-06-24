import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import {
  inspectRuntimeTerminalProcess,
  sendRuntimePtyInputVerified
} from '@/runtime/runtime-terminal-inspection'
import { useAppStore } from '@/store'
import { isExpectedAgentProcess } from '../../../shared/agent-process-recognition'
import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { AgentStartupPlan } from './tui-agent-startup'
import { isShellProcess } from './tui-agent-startup'

type AgentStartupDelivery = {
  worktreeId: string
  primaryTabId?: string | null
  startup: AgentStartupPlan
}

type PendingAgentStartupDelivery = AgentStartupDelivery & {
  expiresAt: number
}

type AgentStartupTerminalBinding = {
  tabId: string
  ptyId: string
  paneKey: string
}

const pendingAgentStartupsByKey = new Map<string, PendingAgentStartupDelivery>()
let unsubscribePendingAgentStartups: (() => void) | null = null
let pendingAgentStartupExpiryTimer: ReturnType<typeof setTimeout> | null = null
const PENDING_AGENT_STARTUP_DELIVERY_MAX_AGE_MS = 60_000

export async function ensureAgentStartupInTerminal(args: {
  worktreeId: string
  primaryTabId?: string | null
  startup: AgentStartupPlan
}): Promise<void> {
  const { worktreeId, primaryTabId, startup } = args
  const draftPrompt = startup.draftPrompt ?? null
  if (startup.followupPrompt === null && draftPrompt === null) {
    return
  }

  const binding = await waitForStartupTerminalBinding(worktreeId, primaryTabId, startup)
  if (binding === 'stale') {
    return
  }
  if (binding === null) {
    queueAgentStartupDelivery({ worktreeId, primaryTabId, startup })
    return
  }

  await deliverAgentStartupToTerminal(binding.tabId, binding.ptyId, startup)
}

async function deliverAgentStartupToTerminal(
  tabId: string,
  ptyId: string,
  startup: AgentStartupPlan
): Promise<void> {
  const draftPrompt = startup.draftPrompt ?? null
  // Why: followupPrompt is the legacy path for stdin-after-start agents that need
  // their initial prompt submitted only after the agent owns the PTY.
  if (startup.followupPrompt) {
    if (!(await waitForAgentForeground(ptyId, startup.expectedProcess))) {
      return
    }
    await sendFollowupPrompt(ptyId, startup.followupPrompt)
  }

  // Why: draftPrompt uses bracketed-paste so the URL lands atomically in the
  // agent input buffer. Shared with launch-work-item-direct for matching behavior.
  if (draftPrompt) {
    await pasteDraftWhenAgentReady({
      tabId,
      content: draftPrompt,
      agent: startup.agent,
      forcePaste: true
    })
  }
}

async function waitForStartupTerminalBinding(
  worktreeId: string,
  primaryTabId: string | null | undefined,
  startup: AgentStartupPlan
): Promise<AgentStartupTerminalBinding | 'stale' | null> {
  // Why: activation creates the tab synchronously but PTY spawn is async, so a
  // brief poll covers the normal path without installing a long-lived watcher.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    const binding = getStartupTerminalBinding(worktreeId, primaryTabId, startup)
    if (binding) {
      return binding
    }
  }
  return null
}

function getStartupTerminalBinding(
  worktreeId: string,
  primaryTabId: string | null | undefined,
  startup: AgentStartupPlan
): AgentStartupTerminalBinding | 'stale' | null {
  const state = useAppStore.getState()
  // Why: workspace activation tells us the exact tab that received the agent
  // startup command, which may differ from the active tab while panes mount.
  const tabId =
    primaryTabId ??
    state.activeTabIdByWorktree[worktreeId] ??
    state.tabsByWorktree[worktreeId]?.[0]?.id ??
    null
  if (!tabId) {
    return null
  }
  const ptyId = state.ptyIdsByTabId[tabId]?.[0] ?? null
  if (!ptyId) {
    return null
  }
  const paneKey = getStartupPaneKey(tabId, ptyId)
  if (!paneKey) {
    return null
  }
  return startupMatchesPaneLaunch(paneKey, startup) ? { tabId, ptyId, paneKey } : 'stale'
}

function queueAgentStartupDelivery(delivery: AgentStartupDelivery): void {
  const key = pendingAgentStartupKey(delivery.worktreeId, delivery.primaryTabId)
  pendingAgentStartupsByKey.set(key, {
    ...delivery,
    expiresAt: Date.now() + PENDING_AGENT_STARTUP_DELIVERY_MAX_AGE_MS
  })
  ensurePendingAgentStartupSubscription()
  schedulePendingAgentStartupExpiry()
}

function pendingAgentStartupKey(worktreeId: string, primaryTabId?: string | null): string {
  return `${worktreeId}:${primaryTabId ?? ''}`
}

function ensurePendingAgentStartupSubscription(): void {
  if (unsubscribePendingAgentStartups) {
    return
  }
  unsubscribePendingAgentStartups = useAppStore.subscribe(() => {
    flushPendingAgentStartups()
  })
}

function flushPendingAgentStartups(): void {
  const now = Date.now()
  for (const [key, delivery] of pendingAgentStartupsByKey) {
    if (delivery.expiresAt <= now) {
      pendingAgentStartupsByKey.delete(key)
      continue
    }
    const binding = getStartupTerminalBinding(
      delivery.worktreeId,
      delivery.primaryTabId,
      delivery.startup
    )
    if (binding === null) {
      continue
    }
    pendingAgentStartupsByKey.delete(key)
    if (binding === 'stale') {
      continue
    }
    void deliverAgentStartupToTerminal(binding.tabId, binding.ptyId, delivery.startup)
  }
  cleanupPendingAgentStartupWatchersIfIdle()
  schedulePendingAgentStartupExpiry()
}

function schedulePendingAgentStartupExpiry(): void {
  if (pendingAgentStartupExpiryTimer) {
    clearTimeout(pendingAgentStartupExpiryTimer)
    pendingAgentStartupExpiryTimer = null
  }
  if (pendingAgentStartupsByKey.size === 0) {
    return
  }
  const nextExpiresAt = Math.min(
    ...Array.from(pendingAgentStartupsByKey.values(), (delivery) => delivery.expiresAt)
  )
  pendingAgentStartupExpiryTimer = setTimeout(
    () => {
      pendingAgentStartupExpiryTimer = null
      flushPendingAgentStartups()
    },
    Math.max(0, nextExpiresAt - Date.now())
  )
}

function cleanupPendingAgentStartupWatchersIfIdle(): void {
  if (pendingAgentStartupsByKey.size > 0) {
    return
  }
  unsubscribePendingAgentStartups?.()
  unsubscribePendingAgentStartups = null
  if (pendingAgentStartupExpiryTimer) {
    clearTimeout(pendingAgentStartupExpiryTimer)
    pendingAgentStartupExpiryTimer = null
  }
}

async function sendFollowupPrompt(ptyId: string, prompt: string): Promise<boolean> {
  try {
    return await sendRuntimePtyInputVerified(useAppStore.getState().settings, ptyId, `${prompt}\r`)
  } catch {
    return false
  }
}

function getStartupPaneKey(tabId: string, ptyId: string): string | null {
  const layout = useAppStore.getState().terminalLayoutsByTabId?.[tabId]
  if (!layout?.ptyIdsByLeafId) {
    return null
  }
  const activeLeafId = layout.activeLeafId
  if (activeLeafId && layout.ptyIdsByLeafId[activeLeafId] === ptyId) {
    return makePaneKey(tabId, activeLeafId)
  }
  for (const [leafId, leafPtyId] of Object.entries(layout.ptyIdsByLeafId)) {
    if (leafPtyId === ptyId) {
      return makePaneKey(tabId, leafId)
    }
  }
  return null
}

function startupMatchesPaneLaunch(paneKey: string, startup: AgentStartupPlan): boolean {
  const entry = useAppStore.getState().agentLaunchConfigByPaneKey?.[paneKey]
  return (
    entry !== undefined &&
    entry.identity?.agentType === startup.agent &&
    launchConfigsMatch(entry.launchConfig, startup.launchConfig)
  )
}

function launchConfigsMatch(
  actual: SleepingAgentLaunchConfig,
  expected: SleepingAgentLaunchConfig
): boolean {
  return (
    (actual.agentCommand ?? '') === (expected.agentCommand ?? '') &&
    actual.agentArgs === expected.agentArgs &&
    stringRecordsMatch(actual.agentEnv ?? {}, expected.agentEnv ?? {})
  )
}

function stringRecordsMatch(
  actual: Record<string, string>,
  expected: Record<string, string>
): boolean {
  const actualKeys = Object.keys(actual)
  const expectedKeys = Object.keys(expected)
  if (actualKeys.length !== expectedKeys.length) {
    return false
  }
  return actualKeys.every((key) => actual[key] === expected[key])
}

async function waitForAgentForeground(ptyId: string, expectedProcess: string): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    try {
      const process = await inspectRuntimeTerminalProcess(useAppStore.getState().settings, ptyId)
      const foreground = process.foregroundProcess?.toLowerCase() ?? ''
      if (isExpectedAgentProcess(foreground, expectedProcess)) {
        return true
      }
      if (attempt >= 4 && !isShellProcess(foreground) && process.hasChildProcesses) {
        return true
      }
    } catch {
      // Ignore transient PTY inspection failures and keep polling.
    }
  }
  return false
}
