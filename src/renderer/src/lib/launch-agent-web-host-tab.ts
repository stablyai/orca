import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  createWebRuntimeAgentSessionTerminal,
  createWebRuntimeAgentSessionTerminalWithLaunchDraft,
  createWebRuntimeSessionTerminal,
  isWebTerminalSurfaceTabId
} from '@/runtime/web-runtime-session'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { Tab } from '../../../shared/tab-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AgentPromptDelivery } from '../../../shared/agent-session-host-authority'
import { translate } from '@/i18n/i18n'
import { toAgentLaunchPreferences } from '@/runtime/agent-session-create-operation'
import { resolveTerminalHostOwnership } from './terminal-worktree-route'

function removeStaleLocalAgentTabsForWebHostLaunch(
  worktreeId: string,
  environmentId: string | null
): void {
  const state = useAppStore.getState()
  const tabHosts = new Map(
    (state.unifiedTabsByWorktree?.[worktreeId] ?? [])
      .filter((tab) => tab.contentType === 'terminal')
      .map((tab) => [tab.entityId, tab.executionHostId])
  )
  for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
    if (!tab.launchAgent || isWebTerminalSurfaceTabId(tab.id)) {
      continue
    }
    // A retained PTY binding is not evidence of a stale row, even if contact was lost.
    if (
      tab.ptyId ||
      state.ptyIdsByTabId[tab.id]?.length ||
      Object.values(state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}).some(Boolean)
    ) {
      continue
    }
    const owner = resolveTerminalHostOwnership(state, worktreeId, 'teardown', tabHosts.get(tab.id))
    if (owner.kind === 'runtime' && owner.runtimeEnvironmentId === environmentId) {
      // Why: pruning a stale local agent tab is a system close — keep it out of
      // the Cmd+Shift+T reopen stack.
      state.closeTab(tab.id, { reason: 'cleanup' })
    }
  }
}

/**
 * Launch an agent terminal on the web runtime host instead of a local tab.
 *
 * Why: paired web tabs are host-owned, so this path never creates a local tab
 * (callers return tabId: null). Local-only agent tabs cannot be closed because
 * close routes through session.tabs.close on the host, so prune them before
 * the host snapshot.
 */
export function launchAgentInWebHostTab(args: {
  agent: TuiAgent
  worktreeId: string
  environmentId: string | null
  groupId?: string
  cwd?: string | null
  startupPlan: AgentStartupPlan
  prompt: string
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  pastePromptAfterReady: string | null
  submitPastedPrompt: boolean
  agentArgs?: string | null
  viewMode?: Tab['viewMode']
  /** Whether the host-created tab takes the foreground; false for a background launch. */
  activate?: boolean
  onPromptDelivered?: () => void
}): Promise<{ delivered: boolean; failureNotified: boolean }> {
  const {
    agent,
    worktreeId,
    environmentId,
    groupId,
    cwd,
    startupPlan,
    prompt,
    promptDelivery,
    pastePromptAfterReady,
    submitPastedPrompt,
    agentArgs,
    viewMode,
    activate = true,
    onPromptDelivered
  } = args
  const hasPrompt = prompt.length > 0
  const launchPreferences = toAgentLaunchPreferences(startupPlan.sessionOptions)
  const structuredPromptDelivery: AgentPromptDelivery =
    promptDelivery === 'draft' ? 'draft' : 'auto-submit'
  const pruneLegacyTabs = (): void => {
    removeStaleLocalAgentTabsForWebHostLaunch(worktreeId, environmentId)
  }
  pruneLegacyTabs()
  const launch = {
    worktreeId,
    environmentId,
    targetGroupId: groupId,
    activate,
    ...(activate ? {} : { selectWorktree: false }),
    ...(cwd?.trim() ? { cwd } : {}),
    ...(viewMode ? { viewMode } : {}),
    agentSessionKind: 'fresh',
    ...(hasPrompt
      ? {
          launchAgent: agent,
          command: startupPlan.launchCommand,
          ...(startupPlan.env ? { env: startupPlan.env } : {}),
          launchConfig: startupPlan.launchConfig,
          ...(startupPlan.startupCommandDelivery
            ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
            : {})
        }
      : { agent }),
    ...(hasPrompt && pastePromptAfterReady === null ? { prompt } : {}),
    ...(hasPrompt && pastePromptAfterReady === null
      ? { promptDelivery: structuredPromptDelivery }
      : {}),
    ...(agentArgs !== undefined ? { agentArgs } : {}),
    ...(launchPreferences ? { launchPreferences } : {})
  } as const

  const handleCreation = ({
    outcome,
    promptDelivered
  }: {
    outcome: Awaited<ReturnType<typeof createWebRuntimeSessionTerminal>>
    promptDelivered: boolean
  }): { delivered: boolean; failureNotified: boolean } => {
    // Why: created means the host accepted the launch, not that a local tab
    // exists; keep pruning stale local rows until the snapshot mirrors.
    pruneLegacyTabs()
    if (outcome.status === 'failed') {
      toast.error(
        outcome.message ||
          translate(
            'auto.lib.launch.agent.in.new.tab.11cce5cc77',
            'Could not launch {{value0}} in a new terminal.',
            { value0: agent }
          )
      )
      return { delivered: false, failureNotified: true }
    }
    if (activate) {
      useAppStore.getState().setActiveTabType('terminal')
    }
    if (hasPrompt && promptDelivered) {
      onPromptDelivered?.()
    }
    return { delivered: promptDelivered, failureNotified: false }
  }

  if (pastePromptAfterReady !== null) {
    return createWebRuntimeAgentSessionTerminal({
      ...launch,
      agent,
      promptAfterReady: pastePromptAfterReady,
      submitPrompt: submitPastedPrompt,
      forcePromptPaste: promptDelivery === 'submit-after-ready'
    }).then(handleCreation)
  }
  if (hasPrompt && promptDelivery === 'draft') {
    // Why: the draft rode in on the launch command, so no paste runs and
    // nothing else seeds the chat-composer copy for this host class.
    return createWebRuntimeAgentSessionTerminalWithLaunchDraft({
      ...launch,
      agent,
      launchDraft: prompt
    }).then((outcome) => handleCreation({ outcome, promptDelivered: outcome.status === 'created' }))
  }
  return createWebRuntimeSessionTerminal(launch).then((outcome) =>
    handleCreation({ outcome, promptDelivered: outcome.status === 'created' && hasPrompt })
  )
}
