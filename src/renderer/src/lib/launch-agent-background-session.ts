import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { buildAgentStartupPlan, type AgentStartupPlan } from '@/lib/tui-agent-startup'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../shared/types'
import type { LaunchSource } from '../../../shared/telemetry-events'
import { FIRST_PANE_ID } from '../../../shared/pane-key'
import {
  registerEagerPtyBuffer,
  subscribeToPtyData,
  subscribeToPtyExit
} from '@/components/terminal-pane/pty-dispatcher'
import { createAgentStatusOscProcessor } from '@/components/terminal-pane/agent-status-osc'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import {
  getRemoteRuntimeTerminalHandle,
  subscribeToRuntimeTerminalData,
  toRemoteRuntimePtyId
} from '@/runtime/runtime-terminal-stream'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import type { RuntimeTerminalCreate } from '../../../shared/runtime-types'

export type LaunchAgentBackgroundSessionArgs = {
  agent: TuiAgent
  worktreeId: string
  prompt?: string
  launchSource?: LaunchSource
  title?: string
  onExit?: (ptyId: string, code: number) => void
  onAgentStatus?: (payload: ParsedAgentStatusPayload) => void
}

export type LaunchAgentBackgroundSessionResult = {
  tabId: string
  ptyId: string
  startupPlan: AgentStartupPlan
}

export async function launchAgentBackgroundSession(
  args: LaunchAgentBackgroundSessionArgs
): Promise<LaunchAgentBackgroundSessionResult | null> {
  const { agent, worktreeId, prompt, launchSource, title, onExit, onAgentStatus } = args
  const store = useAppStore.getState()
  const worktree = store.allWorktrees().find((entry) => entry.id === worktreeId)
  const repo = worktree ? store.repos.find((entry) => entry.id === worktree.repoId) : null
  if (!worktree) {
    throw new Error('The target workspace is no longer available.')
  }
  const cmdOverrides = store.settings?.agentCmdOverrides ?? {}
  const trimmedPrompt = prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  const isFollowupPath = TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start'

  let startupPlan: AgentStartupPlan | null = null
  let pasteDraftAfterLaunch: string | null = null
  if (hasPrompt && isFollowupPath) {
    startupPlan = buildAgentStartupPlan({
      agent,
      prompt: '',
      cmdOverrides,
      platform: CLIENT_PLATFORM,
      allowEmptyPromptLaunch: true
    })
    pasteDraftAfterLaunch = trimmedPrompt
  } else {
    startupPlan = buildAgentStartupPlan({
      agent,
      prompt: hasPrompt ? trimmedPrompt : '',
      cmdOverrides,
      platform: CLIENT_PLATFORM,
      allowEmptyPromptLaunch: !hasPrompt
    })
  }
  if (!startupPlan) {
    return null
  }

  // Why: automation runs should start without revealing the workspace.
  // Spawn the PTY immediately, then attach an inactive tab to the live session.
  const tab = store.createTab(worktreeId, undefined, undefined, { activate: false })
  if (title) {
    store.setTabCustomTitle(tab.id, title)
  }
  const paneKey = `${tab.id}:${FIRST_PANE_ID}`
  // Why: agent hook callbacks are keyed by pane, and background automation
  // tabs never mount a TerminalPane to inject this env for us.
  const paneEnv = {
    ...startupPlan.env,
    ORCA_PANE_KEY: paneKey,
    ORCA_TAB_ID: tab.id,
    ORCA_WORKTREE_ID: worktreeId
  }
  const runtimeTarget = getActiveRuntimeTarget(store.settings)
  let ptyId: string
  try {
    if (runtimeTarget.kind === 'environment') {
      // Why: runtime environments execute on the server; using local pty.spawn
      // would silently run automation on the client for a remote workspace.
      const created = await callRuntimeRpc<{ terminal: RuntimeTerminalCreate }>(
        runtimeTarget,
        'terminal.create',
        {
          worktree: worktreeId,
          command: startupPlan.launchCommand,
          env: paneEnv,
          title,
          focus: false
        },
        { timeoutMs: 15_000 }
      )
      ptyId = toRemoteRuntimePtyId(created.terminal.handle, runtimeTarget.environmentId)
    } else {
      const result = await window.api.pty.spawn({
        cols: 120,
        rows: 40,
        cwd: worktree.path,
        command: startupPlan.launchCommand,
        env: paneEnv,
        connectionId: repo?.connectionId ?? null,
        worktreeId,
        tabId: tab.id,
        leafId: 'pane:1',
        telemetry: {
          agent_kind: tuiAgentToAgentKind(agent),
          launch_source: launchSource ?? 'unknown',
          request_kind: 'new'
        }
      })
      ptyId = result.id
    }
  } catch (error) {
    store.closeTab(tab.id)
    throw error
  }
  store.updateTabPtyId(tab.id, ptyId)
  let exitHandled = false
  let unsubscribeExit = (): void => {}
  let unsubscribeData = (): void => {}
  const handleExit = (ptyId: string, code: number): void => {
    if (exitHandled) {
      return
    }
    exitHandled = true
    unsubscribeExit()
    unsubscribeData()
    useAppStore.getState().clearTabPtyId(tab.id, ptyId)
    onExit?.(ptyId, code)
  }
  const processAgentStatus = createAgentStatusOscProcessor()
  const handleData = (data: string): void => {
    const processed = processAgentStatus(data)
    for (const payload of processed.payloads) {
      useAppStore.getState().setAgentStatus(paneKey, payload, undefined)
      onAgentStatus?.(payload)
    }
  }
  if (runtimeTarget.kind === 'environment') {
    unsubscribeData = await subscribeToRuntimeTerminalData(
      store.settings,
      ptyId,
      `desktop:background:${tab.id}`,
      handleData
    )
    const terminal = getRemoteRuntimeTerminalHandle(ptyId)
    if (!terminal) {
      throw new Error('Runtime terminal id is invalid.')
    }
    void callRuntimeRpc<{ wait: { exitCode?: number | null } }>(
      runtimeTarget,
      'terminal.wait',
      { terminal, for: 'exit' },
      { timeoutMs: 24 * 60 * 60 * 1000 }
    )
      .then((result) => handleExit(ptyId, result.wait.exitCode ?? 0))
      .catch(() => {})
  } else {
    registerEagerPtyBuffer(ptyId, handleExit)
    unsubscribeData = subscribeToPtyData(ptyId, handleData)
    // Why: opening the workspace attaches a real terminal transport and disposes
    // the eager exit handler. This sidecar keeps automation completion tracking
    // alive regardless of whether the tab is hidden or mounted.
    unsubscribeExit = subscribeToPtyExit(ptyId, (code) => handleExit(ptyId, code))
  }

  if (pasteDraftAfterLaunch !== null) {
    void pasteDraftWhenAgentReady({
      tabId: tab.id,
      content: pasteDraftAfterLaunch,
      agent,
      submit: true,
      onTimeout: () => {
        toast.message("Your automation prompt wasn't sent — open the workspace and paste it.")
        track('agent_error', {
          error_class: 'paste_readiness_timeout',
          agent_kind: tuiAgentToAgentKind(agent)
        })
      }
    })
  }

  return { tabId: tab.id, ptyId, startupPlan }
}
