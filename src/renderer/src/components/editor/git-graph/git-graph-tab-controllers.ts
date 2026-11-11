import { GitGraphHistoryController } from './git-graph-history-controller'

const controllers = new Map<string, GitGraphHistoryController>()
export function gitGraphHistoryForTab(worktreeId: string): GitGraphHistoryController {
  const id = `${worktreeId}::git-graph`
  let controller = controllers.get(id)
  if (!controller) {
    controller = new GitGraphHistoryController(worktreeId)
    controllers.set(id, controller)
  }
  return controller
}

export function disposeGitGraphHistory(tabId: string): void {
  controllers.get(tabId)?.dispose()
  controllers.delete(tabId)
}

export function setGitGraphViewport(
  controller: GitGraphHistoryController,
  field: 'scrollOffset' | 'graphWidth',
  value: number
): void {
  controller[field] = value
}

export function getGitGraphViewport(
  controller: GitGraphHistoryController,
  field: 'scrollOffset' | 'graphWidth'
): number {
  return controller[field]
}
