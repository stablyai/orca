import type { AppState } from '@/store/types'

export function createSourceControlRemoteState(): Pick<
  AppState,
  'remoteStatusesByWorktree' | 'isRemoteOperationActive' | 'remoteOperations'
> {
  return {
    remoteStatusesByWorktree: {},
    isRemoteOperationActive: false,
    remoteOperations: []
  }
}
