import type { Bot } from '../../../../shared/bot-types'
import type { BotChatTreeWorker } from '../../../../shared/bots/bot-chat-tree'
import type { WorktreeStatus } from '../../../../shared/worktree/row-display/worktree-status-rollup'
import type { WorktreeCardLineWorker } from '@/components/sidebar/workspace-card/controller/worktree-card-model'
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

/** Each line's worker as the Chats tab's row shows and opens it, by worktree id. */
export function botSidebarWorkerLines(
  bot: Bot,
  workers: ReadonlyMap<string, BotChatTreeWorker>
): Map<string, WorktreeCardLineWorker> {
  const lines = new Map<string, WorktreeCardLineWorker>()
  for (const [worktreeId, worker] of workers) {
    lines.set(worktreeId, {
      status: botWorkerLineStatus(worker),
      open: botChatTreeWorkerOpen(bot, worker) ?? null
    })
  }
  return lines
}
