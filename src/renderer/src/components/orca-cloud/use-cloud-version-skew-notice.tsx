import React from 'react'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { useCloudRuntimeSkew } from '@/lib/orca-cloud/use-cloud-runtime-skew'
import { ORCA_CLOUD_RECIPE_ID } from '../../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import { CloudVersionSkewNotice } from './CloudWorkspaceNotice'

/** A new cloud workspace for the same repository boots the current image. */
function openNewCloudWorkspace(workspaceId: string): void {
  const state = useAppStore.getState()
  const repoId = findWorktreeById(state, workspaceId)?.repoId
  state.openModal('new-workspace-composer', {
    ...(repoId ? { initialRepoId: repoId } : {}),
    initialEphemeralVmRecipeId: ORCA_CLOUD_RECIPE_ID,
    telemetrySource: 'unknown'
  })
}

/**
 * The version-skew card for a running cloud workspace, checked once the sandbox answers. Null
 * inside the protocol range (normal skew), while unknown, or once dismissed.
 */
export function useCloudVersionSkewNotice(
  workspaceId: string,
  running: boolean
): React.ReactNode | null {
  const { skew, dismiss } = useCloudRuntimeSkew(workspaceId, running)
  if (!skew) {
    return null
  }
  return (
    <CloudVersionSkewNotice
      key="version-skew"
      direction={skew.kind}
      onCheckForUpdates={() => void window.api.updater.check()}
      onCreateWorkspace={() => openNewCloudWorkspace(workspaceId)}
      onDismiss={dismiss}
    />
  )
}
