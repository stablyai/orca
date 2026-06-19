import type { GitStagingArea } from '../../../../shared/types'

export type SourceControlAction = 'discard' | 'stage' | 'unstage'

export function getSourceControlActions(area: GitStagingArea): SourceControlAction[] {
  switch (area) {
    case 'staged':
      return ['unstage']
    case 'unstaged':
    case 'untracked':
      return ['discard', 'stage']
  }
}
