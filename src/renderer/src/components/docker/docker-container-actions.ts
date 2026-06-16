import type { DockerContainerAction, DockerContainerState } from '../../../../shared/docker-types'

/** Lifecycle actions offered for a given container state. `remove` is always last (destructive). */
export function availableActionsForState(state: DockerContainerState): DockerContainerAction[] {
  switch (state) {
    case 'running':
      return ['stop', 'restart', 'pause', 'remove']
    case 'paused':
      return ['unpause', 'stop', 'remove']
    case 'restarting':
      return ['stop', 'remove']
    case 'created':
    case 'exited':
    case 'dead':
      return ['start', 'remove']
    case 'removing':
    case 'unknown':
      return ['remove']
  }
}
