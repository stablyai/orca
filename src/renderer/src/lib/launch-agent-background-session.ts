import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { buildAgentStartupPlan, type AgentStartupPlan } from '@/lib/tui-agent-startup'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../shared/types'
import type { LaunchSource } from '../../../shared/telemetry-events'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  registerEagerPtyBuffer,
  subscribeToPtyData,
  subscribeToPtyExit
} from '@/components/terminal-pane/pty-dispatcher'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import {
  getRemoteRuntimeTerminalHandle,
  subscribeToRuntimeTerminalData,
  toRemoteRuntimePtyId
} from '@/runtime/runtime-terminal-stream'
import { createAgentStatusOscProcessor } from '../../../shared/agent-status-osc'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import type { RuntimeTerminalCreate } from '../../../shared/runtime-types'
import { translate } from '@/i18n/i18n'

export type LaunchAgentBackgroundSessionArgs = {
  agent: TuiAgent
  worktreeId: string
  prompt?: string
  launchSource?: LaunchSource
  title?: string
  onData?: (chunk: string) => void
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
  const { agent, worktreeId, prompt, launchSource, title, onData, onExit, onAgentStatus } = args
  const store = useAppStore.getState()
  const worktree = store.allWorktrees().find((entry) => entry.id === worktreeId)
  const repo = worktree ? store.repos.find((entry) => entry.id === worktree.repoId) : null
  if (!worktree) {
    throw new Error('The target workspace is no longer available.')
  }
  const preflight = TUI_AGENT_CONFIG[agent].preflightTrust
  if (preflight && worktree.path && window.api.agentTrust?.markTrusted) {
    try {
      await window.api.agentTrust.markTrusted({
        preset: preflight,
        workspacePath: worktree.path
      })
    } catch {
      // Best-effort: continue with launch. The user can still accept the trust menu.
    }
  }
  const cmdOverrides = store.settings?.agentCmdOverrides ?? {}
  const agentArgs = resolveTuiAgentLaunchArgs(agent, store.settings?.agentDefaultArgs)
  const agentEnv = resolveTuiAgentLaunchEnv(agent, store.settings?.agentDefaultEnv)
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
      agentArgs,
      agentEnv,
      platform: CLIENT_PLATFORM,
      allowEmptyPromptLaunch: true
    })
    pasteDraftAfterLaunch = trimmedPrompt
  } else {
    startupPlan = buildAgentStartupPlan({
      agent,
      prompt: hasPrompt ? trimmedPrompt : '',
      cmdOverrides,
      agentArgs,
      agentEnv,
      platform: CLIENT_PLATFORM,
      allowEmptyPromptLaunch: !hasPrompt
    })
  }
  if (!startupPlan) {
    return null
  }

  // Why: automation runs should start without revealing the workspace.
  // Spawn the PTY immediately, then attach an inactive tab to the live session.
  const tab = store.createTab(worktreeId, undefined, undefined, {
    activate: false,
    recordInteraction: false
  })
  if (title) {
    store.setTabCustomTitle(tab.id, title, { recordInteraction: false })
  }
  // Why: agent hook callbacks are keyed by pane, and background automation
  // tabs never mount a TerminalPane to inject this env for us.
  const leafId = globalThis.crypto.randomUUID()
  const paneKey = makePaneKey(tab.id, leafId)
  // Why: `title` labels the tab/worktree entry. Pane titles render as an
  // in-terminal title row, so background sessions must not persist it there.
  store.setTabLayout(tab.id, singlePaneLayoutSnapshot(leafId))
  const paneEnv = {
    ...startupPlan.env,
    ORCA_PANE_KEY: paneKey,
    ORCA_TAB_ID: tab.id,
    ORCA_WORKTREE_ID: worktreeId
  }
  const sshConnectionId = repo?.connectionId ?? null
  let pendingSshStartupCommand = sshConnectionId ? startupPlan.launchCommand : null
  let sshStartupInjectTimer: ReturnType<typeof setTimeout> | null = null
  const clearSshStartupInjectTimer = (): void => {
    if (sshStartupInjectTimer !== null) {
      clearTimeout(sshStartupInjectTimer)
      sshStartupInjectTimer = null
    }
  }
  const scheduleSshStartupInjection = (ptyId: string): void => {
    if (!pendingSshStartupCommand) {
      return
    }
    clearSshStartupInjectTimer()
    sshStartupInjectTimer = setTimeout(() => {
      sshStartupInjectTimer = null
      const command = pendingSshStartupCommand
      if (!command) {
        return
      }
      pendingSshStartupCommand = null
      // Why: the SSH relay ignores spawn.command for interactive PTYs; hidden
      // automation tabs must type the startup command themselves after shell output.
      const submittedCommand =
        command.endsWith('\r') || command.endsWith('\n') ? command : `${command}\r`
      window.api.pty.write(ptyId, submittedCommand)
    }, 50)
  }
  // Route by the worktree's owner host: the agent terminal must spawn on the host
  // that owns this worktree, not on the focused runtime.
  const runtimeTarget = getActiveRuntimeTarget(
    getSettingsForWorktreeRuntimeOwner(store, worktreeId)
  )
  let ptyId: string
  try {
    if (runtimeTarget.kind === 'environment') {
      // Why: runtime environments execute on the server; using local pty.spawn
      // would silently run automation on the client for a remote workspace.
      const created = await callRuntimeRpc<{ terminal: RuntimeTerminalCreate }>(
        runtimeTarget,
        'terminal.create',
        {
          worktree: toRuntimeWorktreeSelector(worktreeId),
          command: startupPlan.launchCommand,
          env: paneEnv,
          title,
          tabId: tab.id,
          leafId,
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
        ...(sshConnectionId ? {} : { command: startupPlan.launchCommand }),
        env: paneEnv,
        connectionId: sshConnectionId,
        worktreeId,
        tabId: tab.id,
        leafId,
        telemetry: {
          agent_kind: tuiAgentToAgentKind(agent),
          launch_source: launchSource ?? 'unknown',
          request_kind: 'new'
        }
      })
      ptyId = result.id
    }
  } catch (error) {
    store.closeTab(tab.id, { recordInteraction: false })
    throw error
  }
  store.updateTabPtyId(tab.id, ptyId)
  store.setTabLayout(tab.id, singlePaneLayoutSnapshot(leafId, ptyId))
  if (agent === 'command-code' && hasPrompt && !isFollowupPath) {
    // Why: Command Code does not expose a prompt-start hook; seed working for
    // hidden prompt launches so sidebar/activity surfaces do not stay idle.
    store.setAgentStatus(paneKey, {
      state: 'working',
      prompt: trimmedPrompt,
      agentType: agent
    })
  }
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
    clearSshStartupInjectTimer()
    useAppStore.getState().clearTabPtyId(tab.id, ptyId)
    onExit?.(ptyId, code)
  }
  const processAgentStatus = createAgentStatusOscProcessor()
  const handleData = (data: string): void => {
    onData?.(data)
    scheduleSshStartupInjection(ptyId)
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
        toast.message(
          translate(
            'auto.lib.launch.agent.background.session.4ca0651d56',
            "Your automation prompt wasn't sent — open the workspace and paste it."
          )
        )
        track('agent_error', {
          error_class: 'paste_readiness_timeout',
          agent_kind: tuiAgentToAgentKind(agent)
        })
      }
    })
  }

  return { tabId: tab.id, ptyId, startupPlan }
}
