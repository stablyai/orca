import { toast } from 'sonner'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import { TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/types'
import { slugifyForWorkspaceName } from '../../../../shared/workspace-name'
import type {
  PreparedAgentSessionFork,
  StartAgentSessionForkOptions
} from './terminal-agent-session-fork'
import { getForkAgentLaunchPlatform } from './terminal-agent-session-fork-platform'
import { startRuntimeAgentSessionFork } from './terminal-agent-session-fork-runtime'

type ForkableWorktree = {
  id: string
  repoId: string
  displayName?: string | null
  branch?: string | null
  isArchived?: boolean
  isBare?: boolean
  path?: string | null
}

type ForkableRepo = {
  kind?: string
  connectionId?: string | null
}

function buildForkWorkspaceName(sourceName: string): string {
  return slugifyForWorkspaceName(sourceName.concat('-fork')) || 'session-fork'
}

function getUsableForkBase(
  worktree: ForkableWorktree | null | undefined,
  repo: ForkableRepo | null | undefined,
  worktreeId: string
): string | null | undefined {
  if (repo?.kind === 'folder') {
    return undefined
  }
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

async function copyForkContext(prompt: string, fork: PreparedAgentSessionFork): Promise<boolean> {
  try {
    await window.api.ui.writeClipboardText(prompt)
    toast.message(
      translate(
        'auto.components.terminal.pane.terminal.agent.session.fork.c00421d320',
        'Fork context copied. Launch an agent and paste it to start the fork.'
      )
    )
    fork.pane.terminal.focus()
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
    fork.pane.terminal.focus()
    return false
  }
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

export async function copyAgentSessionForkContext(
  fork: PreparedAgentSessionFork
): Promise<boolean> {
  return copyForkContext(fork.prompt, fork)
}

async function startAgentSessionForkInSourceWorkspace(
  fork: PreparedAgentSessionFork,
  sourceWorktree: ForkableWorktree,
  sourceRepo: ForkableRepo | null | undefined,
  sourceProjectRuntime: ProjectExecutionRuntimeResolution | undefined,
  options: StartAgentSessionForkOptions
): Promise<boolean> {
  if (sourceWorktree.isArchived || sourceWorktree.isBare) {
    toast.error(
      translate(
        'auto.components.terminal.pane.terminal.agent.session.fork.3ac98a9c04',
        'This workspace cannot be forked.'
      )
    )
    return false
  }
  if (!fork.agent) {
    return copyAgentSessionForkContext(fork)
  }
  await preflightForkAgentTrust({
    agent: fork.agent,
    workspacePath: sourceWorktree.path,
    connectionId: sourceRepo?.connectionId
  })
  const launchPlatform = getForkAgentLaunchPlatform({
    repo: sourceRepo,
    worktreePath: sourceWorktree.path,
    projectRuntime: sourceProjectRuntime
  })
  const result = launchAgentInNewTab({
    agent: fork.agent,
    worktreeId: sourceWorktree.id,
    groupId: fork.groupId ?? undefined,
    prompt: fork.prompt,
    promptDelivery: 'draft',
    launchSource: 'terminal_context_menu',
    ...(launchPlatform ? { launchPlatform } : {})
  })
  if (options.activate !== false) {
    activateAndRevealWorktree(sourceWorktree.id, { sidebarRevealBehavior: 'auto' })
  }

  if (!result) {
    return copyAgentSessionForkContext(fork)
  }

  toast.success(
    translate(
      'auto.components.terminal.pane.terminal.agent.session.fork.5e69cf039a',
      'Session fork opened in this workspace'
    )
  )
  return true
}

export async function startAgentSessionFork(
  fork: PreparedAgentSessionFork,
  options: StartAgentSessionForkOptions = {}
): Promise<boolean> {
  if (fork.terminalHandle) {
    try {
      return await startRuntimeAgentSessionFork(fork, options)
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.terminal.pane.terminal.agent.session.fork.6b108da085',
              'Failed to fork agent session.'
            )
      )
      return false
    }
  }
  const store = useAppStore.getState()
  const sourceWorktree = store.getKnownWorktreeById(fork.worktreeId) as ForkableWorktree | null
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
  if (options.noCopyFiles === true) {
    return startAgentSessionForkInSourceWorkspace(
      fork,
      sourceWorktree,
      sourceRepo,
      sourceProjectRuntime,
      options
    )
  }
  const sourceBase = getUsableForkBase(sourceWorktree, sourceRepo, fork.worktreeId)
  if (sourceBase === null) {
    toast.error(
      translate(
        'auto.components.terminal.pane.terminal.agent.session.fork.38e41edc6e',
        'This workspace cannot be forked into a git worktree.'
      )
    )
    return false
  }
  const forkName =
    options.name?.trim() ||
    buildForkWorkspaceName(sourceWorktree.displayName || sourceBase || 'session')
  let created: Awaited<ReturnType<typeof store.createWorktree>>
  try {
    created = await store.createWorktree(
      sourceWorktree.repoId,
      forkName,
      sourceBase,
      'inherit',
      undefined,
      'terminal_context_menu',
      'Fork of '.concat(sourceWorktree.displayName || forkName),
      undefined,
      undefined,
      undefined,
      fork.agent ?? undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { parentWorktreeId: sourceWorktree.id }
    )
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
  const forkWorktreeId = created.worktree.id

  if (!fork.agent) {
    if (options.activate !== false) {
      activateAndRevealWorktree(forkWorktreeId, { sidebarRevealBehavior: 'auto' })
    }
    return copyAgentSessionForkContext(fork)
  }
  await preflightForkAgentTrust({
    agent: fork.agent,
    workspacePath: created.worktree.path,
    connectionId: sourceRepo?.connectionId
  })
  const launchPlatform = getForkAgentLaunchPlatform({
    repo: sourceRepo,
    worktreePath: created.worktree.path,
    projectRuntime: sourceProjectRuntime
  })
  const result = launchAgentInNewTab({
    agent: fork.agent,
    worktreeId: forkWorktreeId,
    prompt: fork.prompt,
    promptDelivery: 'draft',
    launchSource: 'terminal_context_menu',
    ...(launchPlatform ? { launchPlatform } : {})
  })
  if (options.activate !== false) {
    activateAndRevealWorktree(forkWorktreeId, { sidebarRevealBehavior: 'auto' })
  }

  if (!result) {
    return copyAgentSessionForkContext(fork)
  }

  toast.success(
    translate(
      'auto.components.terminal.pane.terminal.agent.session.fork.88e34d00eb',
      'Session fork opened in a child workspace'
    )
  )
  return true
}
