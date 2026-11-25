import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'

export type WorktreeRefreshAllOptions = {
  hydrationPurge?: 'allow' | 'defer'
  visibilityOwnerHostId?: ExecutionHostId
}
