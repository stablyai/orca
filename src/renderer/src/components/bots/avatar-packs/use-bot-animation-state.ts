import { useWorktreeActivityStatus } from '@/components/sidebar/workspace-card/activity/use-worktree-activity-status'
import { useWorktreeAgentRows } from '@/components/sidebar/workspace-card/activity/useWorktreeAgentRows'
import { useBotHostOffline } from '@/lib/bot-host-views'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import type { AvatarAnimationState } from './avatar-pack-types'

type BotForAnimationState = {
  hostId?: ExecutionHostId
  paused?: boolean
  folderWorkspaceId?: string | null
}

export function useBotAnimationState(
  bot: BotForAnimationState | null | undefined,
  enabled = true
): AvatarAnimationState {
  const offline = useBotHostOffline(bot?.hostId ?? 'local')
  const folderWorkspaceId = enabled ? bot?.folderWorkspaceId : null
  const workspaceId = folderWorkspaceId ? folderWorkspaceKey(folderWorkspaceId) : ''

  const status = useWorktreeActivityStatus(workspaceId)
  const rows = useWorktreeAgentRows(workspaceId, enabled && Boolean(workspaceId))

  if (!enabled || !bot) {
    return 'idle'
  }
  if (bot.paused || offline) {
    return 'asleep'
  }
  if (!workspaceId) {
    return 'idle'
  }

  if (status === 'permission') {
    return 'help'
  }
  if (status === 'failed' || status === 'interrupted') {
    return 'dizzy'
  }
  if (status === 'done') {
    return 'done'
  }
  if (status === 'working' || status === 'monitoring') {
    const workingRow = rows.find((r) => r.state === 'working')
    const tool = workingRow?.entry?.toolName?.toLowerCase() ?? ''
    if (
      tool.includes('read') ||
      tool.includes('grep') ||
      tool.includes('glob') ||
      tool.includes('search') ||
      tool.includes('view') ||
      tool.includes('cat')
    ) {
      return 'read'
    }
    if (
      tool.includes('edit') ||
      tool.includes('write') ||
      tool.includes('patch') ||
      tool.includes('replace') ||
      tool.includes('create')
    ) {
      return 'edit'
    }
    if (
      tool.includes('bash') ||
      tool.includes('terminal') ||
      tool.includes('sh') ||
      tool.includes('run') ||
      tool.includes('exec') ||
      tool.includes('command')
    ) {
      return 'run'
    }
    return 'think'
  }

  return 'idle'
}
