import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import type { TuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent'
import type { ExecutionHostId } from '../../../../../../../shared/execution-host/execution-host'
import {
  createNativeChatForkWorktree,
  nativeChatSubagentFirstMessage,
  runNativeChatWorktreeFork,
  type NativeChatWorktreeForkBase
} from '../native-chat-worktree-fork'
import type { ChatForkSurface } from '../../../../../../../shared/native-chat/chat-fork-path'
import type { ChatForkRecapScope } from '../../../../../../../shared/agent-session/context/chat-fork-recap'
import type {
  NativeChatForkRoute,
  NativeChatForkRunAs,
  NativeChatForkWorkspaceChoice
} from './native-chat-fork-window-choices'
import type { NativeChatForkWindowSource } from './native-chat-fork-window-source'
import { runNativeChatHostFork } from './native-chat-host-fork'
import { nativeChatForkRecapPrompt, runNativeChatRecapFork } from './native-chat-recap-fork'

/** What the Fork window was confirmed with. */
export type NativeChatForkWindowSelection = {
  throughItemId: string
  draft?: string
  sourceHostId: ExecutionHostId
  hostId: ExecutionHostId
  hostLabel: string
  agent: TuiAgent
  route: NativeChatForkRoute
  openAs: ChatForkSurface
  recapScope: ChatForkRecapScope
  workspace: NativeChatForkWorkspaceChoice
  runAs: NativeChatForkRunAs
  newWorktree: { name: string; displayName: string; base: NativeChatWorktreeForkBase }
  task: string
  /** The forked chat's name, never empty. */
  chatName: string
}

/** The exact copy on the chat's own host: the paths the fork menu always took. */
async function runSameHostFork(
  source: NativeChatForkWindowSource,
  selection: NativeChatForkWindowSelection
): Promise<boolean> {
  const { throughItemId, draft, workspace, chatName } = selection
  const report = { target: source.target, sessionId: source.sessionId, label: source.label }
  const subagent = selection.runAs === 'subagent'
  if (workspace.kind === 'this') {
    void source.request(throughItemId, undefined, undefined, draft, chatName)
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
      chatName,
      ...(draft ? { draft } : {}),
      ...(subagent ? { subagent: { ...report, task: selection.task } } : {})
    })
  }
  const destination = { worktreeId: workspace.worktreeId }
  if (subagent) {
    const question = await nativeChatSubagentFirstMessage(selection.task, report)
    void source.request(throughItemId, { question }, destination, undefined, chatName)
    return true
  }
  activateAndRevealWorktree(workspace.worktreeId, { sidebarRevealBehavior: 'auto' })
  void source.request(throughItemId, undefined, destination, draft, chatName)
  return true
}

/** The workspace a relayed copy or a recap opens in; a new worktree is created for it here. */
async function forkTargetWorktree(
  source: NativeChatForkWindowSource,
  selection: NativeChatForkWindowSelection
): Promise<string | null> {
  const { workspace } = selection
  if (workspace.kind === 'this') {
    return source.worktreeId
  }
  if (workspace.kind === 'existing') {
    return workspace.worktreeId
  }
  return createNativeChatForkWorktree({
    sourceWorktreeId: source.worktreeId,
    base: selection.newWorktree.base,
    agent: selection.agent,
    name: selection.newWorktree.name,
    displayName: selection.newWorktree.displayName
  })
}

/** Runs the confirmed fork; false keeps the window open, because nothing was created. */
export async function runNativeChatForkWindow(
  source: NativeChatForkWindowSource,
  selection: NativeChatForkWindowSelection,
  signal?: AbortSignal
): Promise<boolean> {
  const { route, workspace } = selection
  if (route === 'same') {
    return runSameHostFork(source, selection)
  }
  // Built before any worktree exists, so a chat with nothing to recap leaves none behind.
  const recap =
    route === 'recap'
      ? nativeChatForkRecapPrompt(source, selection.throughItemId, selection.recapScope)
      : null
  if (route === 'recap' && recap === null) {
    return false
  }
  const worktreeId = await forkTargetWorktree(source, selection)
  if (worktreeId === null) {
    return false
  }
  const launched =
    recap === null
      ? await runNativeChatHostFork({
          source,
          throughItemId: selection.throughItemId,
          targetHostId: selection.hostId,
          hostLabel: selection.hostLabel,
          targetWorktreeId: worktreeId,
          openAs: selection.openAs,
          name: selection.chatName,
          ...(selection.draft ? { draft: selection.draft } : {}),
          ...(signal ? { signal } : {})
        })
      : await runNativeChatRecapFork({
          recap,
          agent: selection.agent,
          hostId: selection.hostId,
          openAs: selection.openAs,
          worktreeId,
          name: selection.chatName,
          ...(selection.draft ? { draft: selection.draft } : {}),
          ...(signal ? { signal } : {})
        })
  // A worktree created for the fork exists now; retrying would create a second one.
  return launched || workspace.kind === 'new-worktree'
}
