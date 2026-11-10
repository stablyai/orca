import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import {
  createForkWorktree,
  forkableWorktreeBranch,
  forkWorkspaceName
} from '@/lib/workspace/creation/fork-worktree'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type { NativeChatForkRowAction } from './use-native-chat-fork'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { agentReferenceNote } from '../../../../../../shared/orchestration/mailbox/orchestration-agent-reference'
import { resolveStructuredSessionOrcaSessionId } from '@/runtime/native-chat/orchestration/structured-session-orca-session-id'
import { useWorktreeRuntimeTarget } from '@/runtime/rpc/targets/use-worktree-runtime-target'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { AGENT_SESSION_CREATE_FORK_WORKTREE_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-session/agent-session-create-capabilities'

/** How the fork runs: a worktree you drive, or a background subagent that reports back to this chat. */
export type NativeChatWorktreeForkMode = 'worktree' | 'subagent'

/** Where a fork's new worktree branches from: the project's main branch, or the source's own branch. */
export type NativeChatWorktreeForkBase = 'main' | 'current'

/** The source worktree's branch when it can be forked into a sibling worktree; null otherwise. */
export function nativeChatWorktreeForkSourceBranch(sourceWorktreeId: string): string | null {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(sourceWorktreeId)
  const repo = worktree ? state.repos.find((entry) => entry.id === worktree.repoId) : undefined
  return forkableWorktreeBranch(worktree, repo, sourceWorktreeId)
}

/** Whether a menu should offer forking this worktree's chats: a git worktree whose host can fork into another. */
export function useNativeChatWorktreeForkOffered(worktreeId: string): boolean {
  const target = useWorktreeRuntimeTarget(worktreeId)
  const host = useStructuredAgentSessionHostCapabilityState(
    target,
    AGENT_SESSION_CREATE_FORK_WORKTREE_RUNTIME_CAPABILITY
  )
  return host === 'supported' && nativeChatWorktreeForkSourceBranch(worktreeId) !== null
}

/** The name a fork gets and where it should land, as the dialog shows it before confirming. */
export type NativeChatWorktreeForkPlan = {
  name: string
  displayName: string
  /** The folder Orca creates it in when the project keeps worktrees side by side. */
  folder: string
}

function shortBranch(ref: string): string {
  return ref.replace(/^refs\/heads\//, '')
}

function parentFolder(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut > 0 ? path.slice(0, cut) : path
}

/** The next free `<source>-fork`, `-fork-2`… among the project's worktrees, titled `Fork N of <source>`. */
export function nativeChatWorktreeForkPlan(
  sourceWorktreeId: string
): NativeChatWorktreeForkPlan | null {
  const state = useAppStore.getState()
  const source = state.getKnownWorktreeById(sourceWorktreeId)
  const branch = nativeChatWorktreeForkSourceBranch(sourceWorktreeId)
  if (!source || !branch) {
    return null
  }
  const sourceTitle = source.displayName || shortBranch(branch)
  const taken = new Set(
    (state.worktreesByRepo[source.repoId] ?? []).flatMap((worktree) => [
      worktree.path.split(/[\\/]/).at(-1) ?? '',
      (worktree.branch ? shortBranch(worktree.branch) : '').split('/').at(-1) ?? ''
    ])
  )
  const base = forkWorkspaceName(sourceTitle)
  let index = 1
  while (taken.has(index === 1 ? base : `${base}-${index}`)) {
    index += 1
  }
  return {
    name: index === 1 ? base : `${base}-${index}`,
    displayName: index === 1 ? `Fork of ${sourceTitle}` : `Fork ${index} of ${sourceTitle}`,
    folder: parentFolder(source.path)
  }
}

/** What the subagent is asked to do, plus where to send its report: back into this chat. */
async function subagentFirstMessage(
  task: string,
  report: { target: RuntimeClientTarget; sessionId: string; label: string }
): Promise<string> {
  const address = await resolveStructuredSessionOrcaSessionId(
    report.target,
    report.sessionId
  ).catch(() => null)
  return address
    ? `${task}\n\nWork on this on your own. When you are done, report what you did and found to the chat you were forked from.\n${agentReferenceNote(report.label, address)}`
    : task
}

/** Creates the fork's worktree, nested under its source, then opens the copied chat there.
 *  A subagent starts on its task in the background and you stay in this chat; the source is never touched. */
export async function runNativeChatWorktreeFork(input: {
  sourceWorktreeId: string
  base: NativeChatWorktreeForkBase
  agent: TuiAgent
  throughItemId: string
  request: NativeChatForkRowAction['request']
  name?: string
  displayName?: string
  mode?: NativeChatWorktreeForkMode
  /** With mode subagent: its task, and the chat it reports back to. */
  subagent?: { task: string; target: RuntimeClientTarget; sessionId: string; label: string }
}): Promise<boolean> {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(input.sourceWorktreeId)
  const branch = nativeChatWorktreeForkSourceBranch(input.sourceWorktreeId)
  if (!worktree || !branch) {
    toast.error(
      translate(
        'components.native-chat.fork.worktree.notGit',
        'This chat’s workspace is not a git worktree, so it can’t fork into a new one.'
      )
    )
    return false
  }
  let created: Awaited<ReturnType<typeof createForkWorktree>>
  try {
    created = await createForkWorktree({
      sourceWorktreeId: input.sourceWorktreeId,
      repoId: worktree.repoId,
      sourceName: worktree.displayName || branch,
      sourceDisplayName: worktree.displayName,
      ...(input.base === 'current' ? { baseBranch: branch } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
      agent: input.agent,
      source: 'chat_fork',
      nestUnderSource: true
    })
  } catch (error) {
    toast.error(
      translate(
        'components.native-chat.fork.worktree.createFailed',
        'Couldn’t create the worktree'
      ),
      { description: error instanceof Error ? error.message : undefined }
    )
    return false
  }
  toast.message(
    translate('components.native-chat.fork.worktree.created', 'Created {{name}}', {
      name: created.displayName
    }),
    {
      description: `${created.path}${created.branch ? ` · ${shortBranch(created.branch)}` : ''}`
    }
  )
  const subagent = input.mode === 'subagent' ? input.subagent : undefined
  if (!subagent) {
    activateAndRevealWorktree(created.id, { sidebarRevealBehavior: 'auto' })
  }
  const outcome = await input.request(
    input.throughItemId,
    subagent ? { question: await subagentFirstMessage(subagent.task, subagent) } : undefined,
    { worktreeId: created.id }
  )
  // A launch failure is already reported; a fork that never started says so here.
  if (outcome === undefined) {
    toast.error(
      translate(
        'components.native-chat.fork.worktree.forkNotStarted',
        'The worktree was created, but the chat could not be forked into it.'
      )
    )
  }
  // The worktree exists now, so the dialog is done: retrying would create a second one.
  return true
}
