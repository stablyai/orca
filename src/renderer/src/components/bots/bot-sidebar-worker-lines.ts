import type { BotChatTreeWorker } from '../../../../shared/bots/bot-chat-tree'
import { botLineWorkspaceKey } from '../../../../shared/bots/bot-sidebar-chat-groups'
import type { HostScopedWorktreeKey } from '../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeStatus } from '../../../../shared/worktree/row-display/worktree-status-rollup'
import type { WorktreeCardLineWorker } from '@/components/sidebar/workspace-card/controller/worktree-card-model'
import type { BotOnHost } from '@/lib/bot-hosts'
import { botChatTreeWorkerOpen } from './BotChatTreeWorkerRow'

/** The dot a worker's state draws on its line; null where the host can't see it, so the line keeps its workspace's. */
export function botWorkerLineStatus(worker: BotChatTreeWorker): WorktreeStatus | null {
  if (worker.waitsOnBackground) {
    return 'monitoring'
  }
  switch (worker.state) {
    case 'running':
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

/** Each line's worker as the Chats tab's row shows and opens it, found by the line's host and id:
 *  a line on the host the workers came from matches workers that name no host. */
export function botSidebarWorkerLines(
  bot: BotOnHost,
  workers: ReadonlyMap<HostScopedWorktreeKey, BotChatTreeWorker>
): (line: Pick<Worktree, 'id' | 'hostId'>) => WorktreeCardLineWorker | undefined {
  const lines = new Map<HostScopedWorktreeKey, WorktreeCardLineWorker>()
  for (const [key, worker] of workers) {
    lines.set(key, {
      status: botWorkerLineStatus(worker),
      open: botChatTreeWorkerOpen(bot, worker) ?? null
    })
  }
  return (line) =>
    lines.get(botLineWorkspaceKey(line.hostId === bot.hostId ? undefined : line.hostId, line.id))
}
