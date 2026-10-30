import { useCallback, useState, type ReactNode } from 'react'
import type { Repo } from '../../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { getRepoHostIdentityForParts } from '../../../../../shared/repo-host-identity'
import type { RepositoryPaneRepoUpdate } from './RepositoryPane'
import { useRepositorySourceControlAiSession } from './source-control/RepositorySourceControlAiSection'
import { useSparsePresetSettingsDraft } from '../SparsePresetSettingsSection'
import { useRepoSettingsTextDraft } from './RepositorySettingsDraftInput'
import { useWorktreeSymlinkInput } from '../WorktreeSymlinksSection'
import { useRepositoryHookSettingsDraft } from '../use-repository-hook-settings-draft'
import { useRepositoryIssueCommand } from '../use-repository-issue-command'

export type RepositorySettingsSessionProps = {
  repo: Repo | undefined
  repoId: string
  hostId: ExecutionHostId
  isFolder: boolean
  updateRepo: (
    repoId: string,
    updates: RepositoryPaneRepoUpdate,
    options?: { hostId?: ExecutionHostId }
  ) => void | Promise<boolean>
}

function useRepositorySettingsSession({
  repo,
  repoId,
  hostId,
  isFolder,
  updateRepo
}: RepositorySettingsSessionProps) {
  // This callback and every queued write belong to this concrete session, including catalog gaps.
  const updateSelectedRepo = useCallback(
    (id: string, updates: RepositoryPaneRepoUpdate) => updateRepo(id, updates, { hostId }),
    [updateRepo, hostId]
  )
  const ai = useRepositorySourceControlAiSession({ repo, repoId, updateRepo: updateSelectedRepo })
  const sparse = useSparsePresetSettingsDraft(repoId, isFolder ? undefined : repo)
  const name = useRepoSettingsTextDraft({
    repoId,
    storeValue: repo?.displayName,
    onTextChange: (text) => {
      void updateSelectedRepo(repoId, { displayName: text })
    }
  })
  const location = useRepoSettingsTextDraft({
    repoId,
    storeValue: repo ? (repo.worktreeBasePath ?? '') : undefined,
    onTextChange: () => {}
  })
  const symlinks = useWorktreeSymlinkInput()
  const [website, setWebsite] = useState('')
  const identity = getRepoHostIdentityForParts(repoId, hostId)
  const updateHooks = useCallback(
    (hookSettings: NonNullable<Repo['hookSettings']>) => {
      void updateSelectedRepo(repoId, { hookSettings })
    },
    [updateSelectedRepo, repoId]
  )
  const hooks = useRepositoryHookSettingsDraft({
    repo: isFolder ? undefined : repo,
    repoHostIdentity: identity,
    onUpdateHookSettings: updateHooks
  })
  const issue = useRepositoryIssueCommand({
    repoId,
    selectedHostId: hostId,
    repoHostIdentity: identity,
    enabled: !isFolder
  })
  return {
    ai,
    sparse,
    name,
    location,
    symlinks,
    websiteInput: { website, setWebsite },
    hooks: { hooks, issue },
    updateSelectedRepo
  }
}

export type RepositorySettingsSessionState = ReturnType<typeof useRepositorySettingsSession>

/** One active concrete input session outlives presentation changes, but never a committed departure. */
export function RepositorySettingsSession({
  children,
  ...props
}: RepositorySettingsSessionProps & {
  children: (session: RepositorySettingsSessionState) => ReactNode
}): React.JSX.Element {
  const session = useRepositorySettingsSession(props)
  return <>{children(session)}</>
}
