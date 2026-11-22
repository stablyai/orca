import { botLinearWorkspaces, type Bot } from '../bot-types'

const MAX_REMOVED_INSTALLATIONS = 100

/** The Linear and GitHub links left after taking one off the host's current bot, so a concurrent edit is kept. */
export function withConnectorLinksRemoved(
  bot: Pick<Bot, 'linear' | 'linearWorkspaces' | 'github'>,
  removals: { removeLinearWorkspaceId?: string; removeGitHubInstallationId?: string }
): Partial<Pick<Bot, 'linear' | 'linearWorkspaces' | 'github'>> {
  const { removeLinearWorkspaceId, removeGitHubInstallationId } = removals
  const patch: Partial<Pick<Bot, 'linear' | 'linearWorkspaces' | 'github'>> = {}
  if (removeLinearWorkspaceId) {
    const left = botLinearWorkspaces(bot).filter(
      (entry) => entry.workspaceId !== removeLinearWorkspaceId
    )
    patch.linearWorkspaces = left
    patch.linear = left.at(0) ?? null
  }
  if (removeGitHubInstallationId && bot.github) {
    const removed = new Set(bot.github.removedInstallationIds)
    removed.add(removeGitHubInstallationId)
    if (removed.size > MAX_REMOVED_INSTALLATIONS) {
      throw new Error('bot_github_removed_full')
    }
    patch.github = { ...bot.github, removedInstallationIds: [...removed] }
  }
  return patch
}
