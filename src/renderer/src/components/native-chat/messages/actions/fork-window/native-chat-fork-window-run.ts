import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import type { TuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent'
import type { ExecutionHostId } from '../../../../../../../shared/execution-host'
import {
  createNativeChatForkWorktree,
  nativeChatSubagentFirstMessage,
  runNativeChatWorktreeFork,
  type NativeChatWorktreeForkBase
} from '../native-chat-worktree-fork'
import {
  nativeChatForkRoute,
  type NativeChatForkRunAs,
  type NativeChatForkWorkspaceChoice
} from './native-chat-fork-window-choices'
import type { NativeChatForkWindowSource } from './native-chat-fork-window-source'
import { runNativeChatHostFork } from './native-chat-host-fork'
import { runNativeChatRecapFork } from './native-chat-recap-fork'

/** What the Fork window was confirmed with. */
export type NativeChatForkWindowSelection = {
  throughItemId: string
  draft?: string
  sourceHostId: ExecutionHostId
  hostId: ExecutionHostId
  hostLabel: string
  agent: TuiAgent
  workspace: NativeChatForkWorkspaceChoice
  runAs: NativeChatForkRunAs
  newWorktree: { name: string; displayName: string; base: NativeChatWorktreeForkBase }
  task: string
}

/** The exact copy on the chat's own host: the paths the fork menu always took. */
async function runSameHostFork(
  source: NativeChatForkWindowSource,
  selection: NativeChatForkWindowSelection
): Promise<boolean> {
  const { throughItemId, draft, workspace } = selection
  const report = { target: source.target, sessionId: source.sessionId, label: source.label }
  const subagent = selection.runAs === 'subagent'
  if (workspace.kind === 'this') {
    void source.request(throughItemId, undefined, undefined, draft)
    return true
  }
  if (workspace.kind === 'new-worktree') {
    return runNativeChatWorktreeFork({
      sourceWorktreeId: source.worktreeId,
      base: selection.newWorktree.base,
      agent: source.agent,
      throughItemId,
      request: source.request,
      name: selection.newWorktree.name,
      displayName: selection.newWorktree.displayName,
      mode: subagent ? 'subagent' : 'worktree',
      ...(draft ? { draft } : {}),
      ...(subagent ? { subagent: { ...report, task: selection.task } } : {})
    })
  }
  const destination = { worktreeId: workspace.worktreeId }
  if (subagent) {
    const question = await nativeChatSubagentFirstMessage(selection.task, report)
    void source.request(throughItemId, { question }, destination)
    return true
  }
  activateAndRevealWorktree(workspace.worktreeId, { sidebarRevealBehavior: 'auto' })
  void source.request(throughItemId, undefined, destination, draft)
  return true
}

/** Runs the confirmed fork; false keeps the window open, because nothing was created. */
export async function runNativeChatForkWindow(
  source: NativeChatForkWindowSource,
  selection: NativeChatForkWindowSelection,
  signal?: AbortSignal
): Promise<boolean> {
  const route = nativeChatForkRoute({
    sourceHostId: selection.sourceHostId,
    hostId: selection.hostId,
    sourceAgent: source.agent,
    agent: selection.agent
  })
  if (route === 'same') {
    return runSameHostFork(source, selection)
  }
  const { workspace } = selection
  if (route === 'other-host') {
    return workspace.kind === 'existing'
      ? runNativeChatHostFork({
          source,
          throughItemId: selection.throughItemId,
          targetHostId: selection.hostId,
          hostLabel: selection.hostLabel,
          targetWorktreeId: workspace.worktreeId,
          ...(selection.draft ? { draft: selection.draft } : {}),
          ...(signal ? { signal } : {})
        })
      : false
  }
  const worktreeId =
    workspace.kind === 'this'
      ? source.worktreeId
      : workspace.kind === 'existing'
        ? workspace.worktreeId
        : await createNativeChatForkWorktree({
            sourceWorktreeId: source.worktreeId,
            base: selection.newWorktree.base,
            agent: selection.agent,
            name: selection.newWorktree.name,
            displayName: selection.newWorktree.displayName
          })
  if (worktreeId === null) {
    return false
  }
  const launched = await runNativeChatRecapFork({
    source,
    throughItemId: selection.throughItemId,
    agent: selection.agent,
    worktreeId,
    ...(selection.draft ? { draft: selection.draft } : {}),
    ...(signal ? { signal } : {})
  })
  // A worktree created for the recap exists now; retrying would create a second one.
  return launched || workspace.kind === 'new-worktree'
}
