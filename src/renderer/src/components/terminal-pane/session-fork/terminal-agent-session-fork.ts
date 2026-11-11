import { toast } from 'sonner'
import { launchAgentInNewTabWithOutcome } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab'
import { settleAgentTabLaunch } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab-host-agents'
import { newAgentPromptOutcome } from '@/lib/agent-session/launch/prompt/new-agent-prompt-outcome'
import { buildAgentSessionForkPrompt } from '@/lib/agent-session/context/agent-session-fork-context'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { createForkWorktree, forkableWorktreeBranch } from '@/lib/workspace/creation/fork-worktree'
import { useAppStore } from '@/store/index'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { TUI_AGENT_CONFIG } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import { getForkAgentLaunchPlatform } from './terminal-agent-session-fork-launch-platform'
import { getLocalProjectExecutionRuntimeContext } from '@/runtime/hosts/preflight/local-preflight-context'
import { translate } from '@/i18n/i18n'
import { planAgentSessionLaunch } from '@/lib/agent-session/launch/routing/agent-session-launch-plan'

import { createNonSecureContextUuid } from '../../../../../shared/non-secure-context-uuid'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'

type ForkAgentSessionFromPaneArgs = {
  pane: ManagedPane
  tabId: string
  worktreeId: string
  groupId: string | null
}

export type PreparedAgentSessionFork = {
  prompt: string
  agent: TuiAgent | null
  worktreeId: string
  focusSource: () => void
}

function resolveTuiAgent(value: string | null | undefined): TuiAgent | null {
  return value && Object.hasOwn(TUI_AGENT_CONFIG, value) ? (value as TuiAgent) : null
}

async function copyForkContext(prompt: string, focusSource: () => void): Promise<boolean> {
  try {
    await window.api.ui.writeTerminalClipboardText(prompt)
    toast.message(
      translate(
        'auto.components.terminal.pane.terminal.agent.session.fork.c00421d320',
        'Fork context copied. Launch an agent and paste it to start the fork.'
      )
    )
    focusSource()
    return true
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : translate(
            'auto.components.terminal.pane.terminal.agent.session.fork.2317900211',
            'Failed to copy fork context.'
          )
    )
    focusSource()
    return false
  }
}

export function prepareAgentSessionForkFromPane({
  pane,
  tabId,
  worktreeId
}: ForkAgentSessionFromPaneArgs): PreparedAgentSessionFork | null {
  const paneKey = makePaneKey(tabId, pane.leafId)
  const state = useAppStore.getState()
  const sourceAgent = resolveTuiAgent(state.agentStatusByPaneKey[paneKey]?.agentType)
  const tabAgent = resolveTuiAgent(
    state.tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)?.launchAgent
  )
  const agent = sourceAgent ?? tabAgent
  // This forks context, not the process; xterm capture works for both local and SSH panes.
  const prompt = buildAgentSessionForkPrompt({
    capturedText: pane.serializeAddon.serialize({ scrollback: 800 }),
    sourceLabel: paneKey,
    agentLabel: agent
  })

  if (!prompt) {
    toast.error(
      translate(
        'auto.components.terminal.pane.terminal.agent.session.fork.046e8d853c',
        'No terminal context to fork'
      )
    )
    pane.terminal.focus()
    return null
  }

  return {
    prompt,
    agent,
    worktreeId,
    focusSource: () => pane.terminal.focus()
  }
}

export async function copyAgentSessionForkContext(
  fork: PreparedAgentSessionFork
): Promise<boolean> {
  return copyForkContext(fork.prompt, fork.focusSource)
}

/** Creates a fork worktree from the source branch and starts its agent with the captured context. */
export async function startAgentSessionFork(fork: PreparedAgentSessionFork): Promise<boolean> {
  const store = useAppStore.getState()
  const sourceWorktree = store.getKnownWorktreeById(fork.worktreeId)
  if (!sourceWorktree) {
    toast.error(
      translate(
        'auto.components.terminal.pane.terminal.agent.session.fork.f867385bb5',
        'Could not find the source workspace for this fork.'
      )
    )
    return false
  }
  const sourceRepo = store.repos.find((repo) => repo.id === sourceWorktree.repoId)
  const sourceProjectRuntime = getLocalProjectExecutionRuntimeContext(store, fork.worktreeId)
  const sourceBranch = forkableWorktreeBranch(sourceWorktree, sourceRepo, fork.worktreeId)
  if (!sourceBranch) {
    toast.error(
      translate(
        'auto.components.terminal.pane.terminal.agent.session.fork.38e41edc6e',
        'This workspace cannot be forked into a git worktree.'
      )
    )
    return false
  }
  let created: Awaited<ReturnType<typeof createForkWorktree>>
  try {
    created = await createForkWorktree({
      sourceWorktreeId: fork.worktreeId,
      repoId: sourceWorktree.repoId,
      sourceName: sourceWorktree.displayName || sourceBranch,
      sourceDisplayName: sourceWorktree.displayName,
      baseBranch: sourceBranch,
      agent: fork.agent ?? undefined,
      source: 'terminal_context_menu'
    })
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : translate(
            'auto.components.terminal.pane.terminal.agent.session.fork.fd3d12a1e1',
            'Failed to create fork workspace.'
          )
    )
    return false
  }
  const forkWorktreeId = created.id

  if (!fork.agent) {
    activateAndRevealWorktree(forkWorktreeId, { sidebarRevealBehavior: 'auto' })
    return copyAgentSessionForkContext(fork)
  }
  const agentSessionLaunchPlan = planAgentSessionLaunch(useAppStore.getState(), {
    requestId: createNonSecureContextUuid(),
    agent: fork.agent,
    workspace: { kind: 'git-worktree', worktreeId: forkWorktreeId },
    prompt: fork.prompt,
    promptDelivery: 'draft'
  })
  const launchPlatform = getForkAgentLaunchPlatform({
    repo: sourceRepo,
    worktreePath: created.path,
    projectRuntime: sourceProjectRuntime
  })
  const result = launchAgentInNewTabWithOutcome({
    agent: fork.agent,
    worktreeId: forkWorktreeId,
    prompt: fork.prompt,
    promptDelivery: 'draft',
    launchSource: 'terminal_context_menu',
    agentSessionLaunchPlan,
    // The launcher opens the fork surface; revealing must not seed a sibling shell.
    beforeSurfaceOpen: () =>
      activateAndRevealWorktree(forkWorktreeId, {
        sidebarRevealBehavior: 'auto',
        providesInitialSurface: true
      }) !== false,
    ...(launchPlatform ? { launchPlatform } : {})
  })
  const settled = await settleAgentTabLaunch(result)
  const delivery =
    (result && !('refused' in result) ? result.promptDeliveryResult : undefined) ??
    (settled.kind === 'structured' ? settled.promptDeliveryResult : undefined)
  if (
    (settled.kind !== 'terminal' && settled.kind !== 'structured') ||
    (delivery && !(await newAgentPromptOutcome({ delivery })).delivered)
  ) {
    activateAndRevealWorktree(forkWorktreeId, { sidebarRevealBehavior: 'auto' })
    return copyAgentSessionForkContext(fork)
  }
  notifyForkOpened()
  return true
}

function notifyForkOpened(): void {
  toast.success(
    translate(
      'auto.components.terminal.pane.terminal.agent.session.fork.88e34d00eb',
      'Top-level session fork opened in a new workspace'
    )
  )
}

export async function forkAgentSessionFromPane(args: ForkAgentSessionFromPaneArgs): Promise<void> {
  const fork = prepareAgentSessionForkFromPane(args)
  if (fork) {
    await startAgentSessionFork(fork)
  }
}
