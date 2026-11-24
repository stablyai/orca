import type { BotChatTreeChat, BotChatTreeWorker } from '../../../../shared/bots/bot-chat-tree'
import {
  botLineWorkspaceKey,
  botSidebarLineWorkers
} from '../../../../shared/bots/bot-sidebar-chat-groups'
import type { HostScopedWorktreeKey } from '../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeStatus } from '../../../../shared/worktree/row-display/worktree-status-rollup'
import type { WorktreeCardLineWorker } from '@/components/sidebar/workspace-card/controller/worktree-card-model'
import type { BotOnHost } from '@/lib/bot-hosts'
import { botChatTreeWorkerOpen } from './BotChatTreeWorkerRow'

/** The dot a worker's state draws on its line; null where the host can't see it, so the line keeps its workspace's. */
export function botWorkerLineStatus(worker: BotChatTreeWorker): WorktreeStatus | null {
  switch (worker.state) {
    case 'running':
      return worker.waitsOnBackground ? 'monitoring' : 'working'
    case 'asking-bot':
      return 'working'
    case 'needs-you':
      return 'permission'
    case 'done':
      return 'done'
    case 'failed':
      return 'failed'
    case 'unreachable':
      return null
  }
}

/** Each line's worker as the Chats tab's row shows and opens it, found by the line's host and id. */
export function botSidebarWorkerLines(
  owner: BotOnHost,
  chats: readonly BotChatTreeChat[]
): (line: Pick<Worktree, 'id' | 'hostId'>) => WorktreeCardLineWorker | undefined {
  const lines = new Map<HostScopedWorktreeKey, WorktreeCardLineWorker>()
  for (const [key, worker] of botSidebarLineWorkers(chats, owner.hostId)) {
    lines.set(key, {
      status: botWorkerLineStatus(worker),
      open: botChatTreeWorkerOpen(owner, worker) ?? null
    })
  }
  return (line) => lines.get(botLineWorkspaceKey(line))
}

/** A "Show more" step reads the chat's next page of finished workers while the host holds more than
 *  it sent, so the older lines it reveals have their workers too. */
export function botSidebarStepReadsMore(
  chat: Pick<BotChatTreeChat, 'finished' | 'finishedTotal'>,
  nextSteps: number
): boolean {
  return nextSteps > 0 && chat.finished.length < chat.finishedTotal
}
