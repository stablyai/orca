// D4 in the composer: while Orca Cloud is picked, the Project picker also offers GitHub
// repositories with no clone here. Picking one keeps Orca Cloud and starts it from GitHub.
import { useCallback, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { clearCloudStartDraft } from '@/lib/orca-cloud/cloud-start-draft'
import {
  invalidateOrcaCloudGitHubRepositories,
  useOrcaCloudGitHubRepositories,
  type OrcaCloudGitHubRepository
} from '@/lib/orca-cloud/use-orca-cloud-github-repositories'
import { startCloudWorkspaceFromGitHub } from '@/lib/orca-cloud/start-cloud-workspace-from-github'
import type { CloudSetupStep } from './cloud-start-model'
import { useGitHubAccessHandoff } from './use-github-access-handoff'

export type CloudOnlyRepo = {
  repos: readonly OrcaCloudGitHubRepository[] | null
  /** Fetches GitHub's next pages; null when everything is listed. */
  showMore: (() => void) | null
  picked: OrcaCloudGitHubRepository | null
  /** The project is a plain folder: Orca Cloud needs a GitHub repository (D3/D4). */
  folderProject: boolean
  /** The GitHub row is done for a repository listed from the team's installations. */
  githubStep: CloudSetupStep | null
  pick: (fullName: string) => void
  clear: () => void
  moreAccess: () => void
  /** Back from GitHub's access page: the list re-reads until the new repository shows up. */
  waitingForGitHub: boolean
  start: (request: { prompt: string; agent: string | null }) => Promise<boolean>
}

export function useCloudOnlyRepo({
  repoId,
  initialPicked = null,
  cloudSelected,
  cloudOffered,
  signedIn,
  onAutoPick
}: {
  repoId: string
  /** `owner/repo` picked when the composer opens (Back to draft from its build sheet). */
  initialPicked?: string | null
  /** Orca Cloud is the Run on target. */
  cloudSelected: boolean
  /** This build offers Orca Cloud (the Run on segment is enabled). */
  cloudOffered: boolean
  /** The list needs an account; signed out, setup comes first. */
  signedIn: boolean
  /** A repository granted on GitHub was picked for the person: Run on becomes Orca Cloud. */
  onAutoPick?: () => void
}): CloudOnlyRepo {
  const { folderProject, folderStep } = useFolderGitHubStep(repoId)
  // D4 rows show while Orca Cloud is picked, or for a folder, which can only start from GitHub.
  const enabled = (cloudSelected || folderProject) && cloudOffered
  const [refreshSignal, setRefreshSignal] = useState(0)
  const { repos, showMore } = useOrcaCloudGitHubRepositories(enabled && signedIn, refreshSignal)
  const [pickedName, setPickedName] = useState<string | null>(initialPicked)
  const handoff = useGitHubAccessHandoff({
    repos,
    onReread: () => setRefreshSignal((n) => n + 1),
    onNewRepository: (fullName) => {
      setPickedName(fullName)
      onAutoPick?.()
    }
  })
  const picked = useMemo(
    () => (enabled ? (repos?.find((repo) => repo.fullName === pickedName) ?? null) : null),
    [enabled, pickedName, repos]
  )
  const githubStep = useMemo<CloudSetupStep | null>(
    () =>
      picked
        ? {
            id: 'github',
            state: 'done',
            label: translate('orcaCloud.setup.github.label', 'GitHub access'),
            detail: picked.fullName
          }
        : null,
    [picked]
  )
  const { begin: beginHandoff, cancel: cancelHandoff } = handoff
  const clear = useCallback(() => {
    cancelHandoff()
    setPickedName(null)
  }, [cancelHandoff])
  const pick = useCallback(
    (fullName: string) => {
      cancelHandoff()
      setPickedName(fullName)
    },
    [cancelHandoff]
  )
  const moreAccess = useCallback(() => {
    invalidateOrcaCloudGitHubRepositories()
    beginHandoff()
    void window.api.orcaCloudWorkspace.connectGitHub()
  }, [beginHandoff])
  const start = useCallback(
    (request: { prompt: string; agent: string | null }) =>
      picked
        ? startCloudWorkspaceFromGitHub({
            repoUrl: picked.url,
            fullName: picked.fullName,
            composerRepoId: repoId,
            ...request
          })
        : Promise.resolve(false),
    [picked, repoId]
  )
  return {
    repos,
    showMore,
    picked,
    githubStep: githubStep ?? folderStep,
    folderProject,
    pick,
    clear,
    moreAccess,
    waitingForGitHub: enabled && handoff.waiting,
    start
  }
}

/**
 * The composer's create while a cloud-only repository is picked: start it from GitHub, close the
 * composer, and say which hours it uses (O4). Otherwise the ordinary create.
 */
export function useCloudOnlyCreate({
  cloudOnly,
  createWorkspace,
  prompt,
  agent,
  profileId,
  onClose
}: {
  cloudOnly: CloudOnlyRepo
  createWorkspace: () => void
  prompt: string
  agent: string | null
  profileId: string | null
  onClose?: () => void
}): () => void {
  const { picked, start } = cloudOnly
  return useCallback(() => {
    if (!picked) {
      createWorkspace()
      return
    }
    clearCloudStartDraft(profileId)
    void start({ prompt, agent })
    onClose?.()
  }, [agent, createWorkspace, onClose, picked, profileId, prompt, start])
}

/**
 * A plain folder can't start in Orca Cloud (a sandbox clones from GitHub), but picking Orca Cloud
 * still works: the panel's GitHub repository row says so and offers the way forward (D3 for
 * folders), and the Project picker lists GitHub repositories with no clone here (D4).
 */
export function useFolderGitHubStep(repoId: string): {
  folderProject: boolean
  folderStep: CloudSetupStep | null
} {
  const folderProject = useAppStore(
    (s) => s.repos.find((repo) => repo.id === repoId)?.kind === 'folder'
  )
  const folderStep = useMemo<CloudSetupStep | null>(
    () =>
      folderProject
        ? {
            id: 'github',
            state: 'failed',
            need: 'github',
            blocksStart: true,
            label: translate('orcaCloud.setup.github.repositoryLabel', 'GitHub repository'),
            status: translate('orcaCloud.setup.github.neededStatus', 'Needed'),
            detail: translate(
              'components.newWorkspace.cloudOnly.folderDetail',
              'Orca Cloud starts from a GitHub repository. This project is a folder on this computer.'
            )
          }
        : null,
    [folderProject]
  )
  return { folderProject, folderStep }
}
