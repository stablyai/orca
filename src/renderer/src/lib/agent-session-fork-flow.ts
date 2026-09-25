import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { settingsForRepoOwner } from '@/store/repos/owner-routing'
import { translate } from '@/i18n/i18n'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { carryRuntimeWorkingTreeChanges } from '@/runtime/runtime-git-working-tree-carry-client'
import { classifyWorkingTreeCarryRejection } from '@/runtime/runtime-git-working-tree-carry-rejection'
import type {
  WorkingTreeCarryFailureReason,
  WorkingTreeCarryResult
} from '../../../shared/working-tree-change-carry'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  launchNativeAgentSessionFork,
  launchTranscriptAgentSessionFork,
  type AgentForkLaunchSource
} from './agent-session-fork-launch'
import type { ForkableAgentSession } from './worktree-agent-fork-sessions'

export type AgentSessionForkSource =
  | { kind: 'native'; session: ForkableAgentSession }
  | { kind: 'transcript'; agent: TuiAgent; prompt: string }
  | { kind: 'none' }

export type AgentSessionForkStage = 'creating' | 'carrying' | 'launching'

/** Where the child branch starts: the parent's HEAD, the repo's default base, or a chosen ref. */
export type AgentSessionForkBase =
  | { kind: 'parent-commit' }
  | { kind: 'repo-default' }
  | { kind: 'ref'; ref: string }

export type AgentSessionForkRequest = {
  sourceWorktreeId: string
  name: string
  source: AgentSessionForkSource
  asChild: boolean
  carryChanges: boolean
  /** The parent's HEAD for a parent-commit base; null falls back to the parent branch. */
  sourceHeadOid: string | null
  base: AgentSessionForkBase
  launchSource: AgentForkLaunchSource
}

export type AgentSessionForkWarning =
  | { kind: 'changes-not-carried'; reason: WorkingTreeCarryFailureReason }
  | { kind: 'agent-not-started' }

export type AgentSessionForkOutcome =
  | { ok: true; worktreeId: string; warnings: AgentSessionForkWarning[] }
  | { ok: false; error: string }

type ForkTarget = { id: string; path: string }

function shortBranchName(branch: string | null | undefined): string | null {
  const trimmed = branch?.trim()
  if (!trimmed) {
    return null
  }
  return trimmed.startsWith('refs/heads/') ? trimmed.slice('refs/heads/'.length) : trimmed
}

// Why: undefined lets createWorktree resolve the repo's configured default base ref.
function resolveCreateBase(
  request: AgentSessionForkRequest,
  parentBranch: string | null
): string | undefined {
  if (request.base.kind === 'ref') {
    return request.base.ref
  }
  if (request.base.kind === 'repo-default') {
    return undefined
  }
  return request.sourceHeadOid ?? parentBranch ?? undefined
}

function sourceAgent(source: AgentSessionForkSource): TuiAgent | undefined {
  if (source.kind === 'native') {
    return source.session.agent
  }
  return source.kind === 'transcript' ? source.agent : undefined
}

async function carryChangesIntoChild(
  args: Parameters<typeof carryRuntimeWorkingTreeChanges>[0]
): Promise<WorkingTreeCarryResult> {
  try {
    return await carryRuntimeWorkingTreeChanges(args)
  } catch (error) {
    // Why: a rejected carry (unreachable host, RPC timeout) must not undo a fork that already exists.
    console.error('[agent-session-fork] carrying changes failed', error)
    return { ok: false, reason: classifyWorkingTreeCarryRejection(error) }
  }
}

export async function copyTranscriptPrompt(prompt: string): Promise<boolean> {
  try {
    await window.api.ui.writeTerminalClipboardText(prompt)
    toast.message(
      translate(
        'auto.components.terminal.pane.terminal.agent.session.fork.c00421d320',
        'Fork context copied. Launch an agent and paste it to start the fork.'
      )
    )
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
    return false
  }
}

async function launchForkAgent(
  source: AgentSessionForkSource,
  child: ForkTarget,
  connectionId: string | null,
  launchSource: AgentForkLaunchSource
): Promise<boolean> {
  if (source.kind === 'native') {
    return launchNativeAgentSessionFork({
      session: source.session,
      worktreeId: child.id,
      worktreePath: child.path,
      connectionId,
      launchSource
    })
  }
  if (source.kind === 'none') {
    return true
  }
  const launched = await launchTranscriptAgentSessionFork({
    agent: source.agent,
    prompt: source.prompt,
    worktreeId: child.id,
    worktreePath: child.path,
    launchSource
  })
  if (!launched) {
    // Why: keeps the old fallback — the transcript is lost otherwise, so hand it to the user to paste.
    await copyTranscriptPrompt(source.prompt)
  }
  return launched
}

export async function runAgentSessionFork(
  request: AgentSessionForkRequest,
  onStage: (stage: AgentSessionForkStage) => void
): Promise<AgentSessionForkOutcome> {
  const state = useAppStore.getState()
  const sourceWorktree = state.getKnownWorktreeById(request.sourceWorktreeId)
  if (!sourceWorktree) {
    return {
      ok: false,
      error: translate(
        'components.agentSessionFork.sourceMissing',
        'The source workspace no longer exists.'
      )
    }
  }
  const repo = state.repos.find((entry) => entry.id === sourceWorktree.repoId)
  const connectionId = repo?.connectionId ?? null
  const parentBranch = shortBranchName(sourceWorktree.branch)
  const startsAtParentCommit =
    request.base.kind === 'parent-commit' && request.sourceHeadOid !== null
  const base = resolveCreateBase(request, parentBranch)

  onStage('creating')
  let created: Awaited<ReturnType<typeof state.createWorktree>>
  try {
    created = await state.createWorktree(
      sourceWorktree.repoId,
      request.name,
      base,
      'inherit',
      undefined,
      request.launchSource,
      undefined,
      undefined,
      undefined,
      undefined,
      sourceAgent(request.source),
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
      // Why: the child's Source Control compares against the parent, not the repo default branch.
      startsAtParentCommit ? (parentBranch ?? undefined) : undefined,
      request.asChild ? { parentWorktreeId: sourceWorktree.id } : undefined
    )
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const child: ForkTarget = { id: created.worktree.id, path: created.worktree.path }
  const warnings: AgentSessionForkWarning[] = []

  // Why: the carry applies a stash made on the parent's HEAD, so any other base would half-apply.
  if (request.carryChanges && startsAtParentCommit) {
    onStage('carrying')
    const carried = await carryChangesIntoChild({
      // Why: the same owner routing createWorktree used, so the carry runs on the child's host.
      settings: settingsForRepoOwner(state, sourceWorktree.repoId),
      connectionId: connectionId ?? undefined,
      source: { worktreeId: sourceWorktree.id, worktreePath: sourceWorktree.path },
      target: { worktreeId: child.id, worktreePath: child.path }
    })
    if (!carried.ok) {
      warnings.push({ kind: 'changes-not-carried', reason: carried.reason })
    }
  }

  onStage('launching')
  const agentOpensSurface = request.source.kind !== 'none'
  // Why: after the carry so setup sees the carried files; before the agent tab so that tab stays in front.
  activateAndRevealWorktree(child.id, {
    sidebarRevealBehavior: 'auto',
    ...(created.setup ? { setup: created.setup } : {}),
    ...(created.defaultTabs ? { defaultTabs: created.defaultTabs } : {}),
    ...(agentOpensSurface ? { providesInitialSurface: true } : {})
  })
  const launched = await launchForkAgent(request.source, child, connectionId, request.launchSource)
  if (!launched) {
    warnings.push({ kind: 'agent-not-started' })
    // Why: the first activation left the surface to the agent tab, so reseed a shell in its place.
    activateAndRevealWorktree(child.id, { sidebarRevealBehavior: 'auto' })
  }
  return { ok: true, worktreeId: child.id, warnings }
}
