import { toast } from 'sonner'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { buildAgentSessionForkPrompt } from '@/lib/agent-session-fork-context'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import { slugifyForWorkspaceName } from '../../../../shared/workspace-name'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { TuiAgent } from '../../../../shared/types'
import { isWslUncPath } from '../../../../shared/wsl-paths'

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
  pane: ManagedPane
}

function buildForkWorkspaceName(sourceName: string): string {
  return slugifyForWorkspaceName(`${sourceName}-fork`) || 'session-fork'
}

function resolveTuiAgent(value: string | null | undefined): TuiAgent | null {
  return value && Object.prototype.hasOwnProperty.call(TUI_AGENT_CONFIG, value)
    ? (value as TuiAgent)
    : null
}

function getUsableForkBase(
  worktree:
    | { branch?: string | null; isArchived?: boolean; isBare?: boolean; repoId?: string }
    | null
    | undefined,
  repo: { kind?: string } | null | undefined,
  worktreeId: string
): string | null {
  const branch = worktree?.branch?.trim()
  if (
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID ||
    !branch ||
    worktree?.isArchived ||
    worktree?.isBare ||
    !repo ||
    repo.kind === 'folder'
  ) {
    return null
  }
  return branch
}

async function copyForkContext(prompt: string, pane: ManagedPane): Promise<boolean> {
  try {
    await window.api.ui.writeClipboardText(prompt)
    toast.message('Fork context copied. Launch an agent and paste it to start the fork.')
    pane.terminal.focus()
    return true
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to copy fork context.')
    pane.terminal.focus()
    return false
  }
}

function getForkAgentLaunchPlatform(args: {
  repo: { connectionId?: string | null } | null | undefined
  worktreePath?: string | null
}): NodeJS.Platform | undefined {
  if (args.repo?.connectionId || (args.worktreePath && isWslUncPath(args.worktreePath))) {
    return 'linux'
  }
  return undefined
}

async function preflightForkAgentTrust(args: {
  agent: TuiAgent
  workspacePath?: string | null
  connectionId?: string | null
}): Promise<void> {
  const { agent, workspacePath, connectionId } = args
  const preflight = TUI_AGENT_CONFIG[agent].preflightTrust
  if (!preflight || !workspacePath || !window.api.agentTrust?.markTrusted) {
    return
  }
  try {
    await window.api.agentTrust.markTrusted({
      preset: preflight,
      workspacePath,
      ...(connectionId ? { connectionId } : {})
    })
  } catch {
    // Best-effort: if the trust artifact cannot be written, keep the existing launch path.
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
  // Why: v1 is a context fork, not a process clone. Capturing scrollback keeps
  // SSH and local panes on the same path because both expose xterm state here.
  const prompt = buildAgentSessionForkPrompt({
    capturedText: pane.serializeAddon.serialize({ scrollback: 800 }),
    sourceLabel: paneKey,
    agentLabel: agent
  })

  if (!prompt) {
    toast.error('No terminal context to fork')
    pane.terminal.focus()
    return null
  }

  return {
    prompt,
    agent,
    worktreeId,
    pane
  }
}

export async function copyAgentSessionForkContext(
  fork: PreparedAgentSessionFork
): Promise<boolean> {
  return copyForkContext(fork.prompt, fork.pane)
}

export async function startAgentSessionFork(fork: PreparedAgentSessionFork): Promise<boolean> {
  const store = useAppStore.getState()
  const sourceWorktree = store.getKnownWorktreeById(fork.worktreeId)
  if (!sourceWorktree) {
    toast.error('Could not find the source workspace for this fork.')
    return false
  }
  const sourceRepo = store.repos.find((repo) => repo.id === sourceWorktree.repoId)
  const sourceBranch = getUsableForkBase(sourceWorktree, sourceRepo, fork.worktreeId)
  if (!sourceBranch) {
    toast.error('This workspace cannot be forked into a git worktree.')
    return false
  }
  const forkName = buildForkWorkspaceName(sourceWorktree.displayName || sourceBranch)
  let created: Awaited<ReturnType<typeof store.createWorktree>>
  try {
    created = await store.createWorktree(
      sourceWorktree.repoId,
      forkName,
      sourceBranch,
      'inherit',
      undefined,
      'terminal_context_menu',
      `Fork of ${sourceWorktree.displayName || forkName}`,
      undefined,
      undefined,
      undefined,
      fork.agent ?? undefined
    )
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to create fork workspace.')
    return false
  }
  const forkWorktreeId = created.worktree.id

  if (!fork.agent) {
    activateAndRevealWorktree(forkWorktreeId, { sidebarRevealBehavior: 'auto' })
    return copyAgentSessionForkContext(fork)
  }
  await preflightForkAgentTrust({
    agent: fork.agent,
    workspacePath: created.worktree.path,
    connectionId: sourceRepo?.connectionId
  })
  const launchPlatform = getForkAgentLaunchPlatform({
    repo: sourceRepo,
    worktreePath: created.worktree.path
  })
  const result = launchAgentInNewTab({
    agent: fork.agent,
    worktreeId: forkWorktreeId,
    prompt: fork.prompt,
    promptDelivery: 'draft',
    launchSource: 'terminal_context_menu',
    ...(launchPlatform ? { launchPlatform } : {})
  })
  activateAndRevealWorktree(forkWorktreeId, { sidebarRevealBehavior: 'auto' })

  if (!result) {
    return copyAgentSessionForkContext(fork)
  }

  toast.success('Top-level session fork opened in a new workspace')
  return true
}

export async function forkAgentSessionFromPane(args: ForkAgentSessionFromPaneArgs): Promise<void> {
  const fork = prepareAgentSessionForkFromPane(args)
  if (fork) {
    await startAgentSessionFork(fork)
  }
}
