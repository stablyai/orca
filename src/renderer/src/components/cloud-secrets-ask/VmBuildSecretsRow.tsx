import React, { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import { cloudSecretRepoKey } from '@/components/settings/cloud-secrets/cloud-secret-repos'
import {
  clearCloudSecretsMissing,
  recordCloudSecretsMissing
} from '@/lib/orca-cloud/cloud-secrets-missing-notice-store'
import { isOrcaCloudBuild } from '../worktree-creation/vm-build-steps'
import type { CloudSecretsAskData } from './cloud-secrets-ask-model'
import {
  CloudSecretsAskForm,
  type CloudSecretsAskFormActions,
  type CloudSecretsAskFormState
} from './CloudSecretsAskForm'
import { useCloudSecretsAskLoad } from './use-cloud-secrets-ask'
import { useCloudSecretsAskForm } from './use-cloud-secrets-ask-form'

/** The build sheet's list item around the form; separated from the steps above like the Agents row. */
export function VmBuildSecretsRowView({
  data,
  state,
  actions
}: {
  data: CloudSecretsAskData
  state: CloudSecretsAskFormState
  actions: CloudSecretsAskFormActions
}): React.JSX.Element | null {
  // Hidden when nothing is missing, unless it is confirming a save.
  if (data.missing.length === 0 && state.phase !== 'saved') {
    return null
  }
  return (
    <li data-vm-build-secrets="" className="mt-1 border-t border-border/60 pt-2">
      <CloudSecretsAskForm data={data} state={state} actions={actions} />
    </li>
  )
}

/**
 * S2 on the Orca Cloud build sheet: the Cloud environment's declared names that this person's
 * workspace won't get, asked inline. Never blocks Open. Left unfilled, it becomes the workspace
 * panel's "secrets missing" notice.
 */
export function VmBuildSecretsRow({
  entry
}: {
  entry: PendingWorktreeCreation
}): React.JSX.Element | null {
  const cloud = isOrcaCloudBuild(entry)
  const sourceRepoId = entry.request.ephemeralVmRecipe?.sourceRepoId
  const githubName = entry.request.githubSource?.fullName
  const repoKey = useAppStore((state) => {
    if (githubName) {
      return `github.com/${githubName.toLowerCase()}`
    }
    const repo = state.repos.find((candidate) => candidate.id === sourceRepoId)
    return repo ? cloudSecretRepoKey(repo) : null
  })
  const { load, reload } = useCloudSecretsAskLoad(cloud ? repoKey : null)
  const data = load.status === 'ready' ? load.data : null

  // What to leave behind for the workspace panel if the sheet closes with names unfilled.
  const leaveBehind = useRef<{ workspaceId: string | null; names: string[] }>({
    workspaceId: null,
    names: []
  })
  const workspaceId = entry.worktreeId ?? null
  const missing = data?.missing
  useEffect(() => {
    leaveBehind.current.workspaceId = workspaceId
    leaveBehind.current.names = missing ?? []
  }, [workspaceId, missing])

  const onSaved = useCallback(() => reload(), [reload])
  // Skipping only collapses the row; the panel notice is left either way when the sheet closes.
  const onSkip = useCallback(() => {}, [])
  const { state, actions } = useCloudSecretsAskForm({
    data,
    // Only once the sandbox answers; before that its first session env reads the new values anyway.
    refreshRuntimeEnvironmentId: entry.vmEnvironmentId ?? null,
    onSaved,
    onSkip
  })

  useEffect(() => {
    const record = leaveBehind.current
    return () => {
      if (!record.workspaceId || !repoKey) {
        return
      }
      if (record.names.length > 0) {
        recordCloudSecretsMissing(record.workspaceId, { names: record.names, repoKey })
      } else {
        clearCloudSecretsMissing(record.workspaceId)
      }
    }
  }, [repoKey])

  if (!data) {
    return null
  }
  return <VmBuildSecretsRowView data={data} state={state} actions={actions} />
}
