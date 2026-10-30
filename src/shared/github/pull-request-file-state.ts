import type { GitBranchChangeEntry } from '../git-diff-compare-types'
import type { GitHubPRFile } from './pull-request-types'

type ViewedStateFile = Pick<GitHubPRFile, 'viewerViewedState'>

export function isPRFileViewed(file: ViewedStateFile): boolean {
  return file.viewerViewedState === 'VIEWED'
}

/** GitHub clears a viewed mark when the file changes again and reports DISMISSED. */
export function isPRFileChangedSinceViewed(file: ViewedStateFile): boolean {
  return file.viewerViewedState === 'DISMISSED'
}

export function mapPRFileStatus(status: GitHubPRFile['status']): GitBranchChangeEntry['status'] {
  switch (status) {
    case 'added':
      return 'added'
    case 'removed':
      return 'deleted'
    case 'renamed':
      return 'renamed'
    case 'copied':
      return 'copied'
    case 'changed':
    case 'modified':
    case 'unchanged':
      return 'modified'
  }
}
