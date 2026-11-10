// D4 in the composer: while Orca Cloud is picked, the Project picker also offers GitHub
// repositories with no clone here. Picking one keeps Orca Cloud and starts it from GitHub.
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { clearCloudStartDraft } from '@/lib/orca-cloud/cloud-start-draft'
import {
  invalidateOrcaCloudGitHubRepositories,
  useOrcaCloudGitHubRepositories,
  type OrcaCloudGitHubRepository
} from '@/lib/orca-cloud/use-orca-cloud-github-repositories'
import { startCloudWorkspaceFromGitHub } from '@/lib/orca-cloud/start-cloud-workspace-from-github'
import type { CloudSetupStep } from './cloud-start-model'

export type CloudOnlyRepo = {
  repos: readonly OrcaCloudGitHubRepository[] | null
  /** Fetches GitHub's next pages; null when everything is listed. */
  showMore: (() => void) | null
  picked: OrcaCloudGitHubRepository | null
  /** The GitHub row is done for a repository listed from the team's installations. */
  githubStep: CloudSetupStep | null
  pick: (fullName: string) => void
  clear: () => void
  moreAccess: () => void
  start: (request: { prompt: string; agent: string | null }) => Promise<boolean>
}

export function useCloudOnlyRepo({
  enabled,
  signedIn
}: {
  /** Orca Cloud is the Run on target. */
  enabled: boolean
  /** The list needs an account; signed out, setup comes first. */
  signedIn: boolean
}): CloudOnlyRepo {
  const { repos, showMore } = useOrcaCloudGitHubRepositories(enabled && signedIn)
  const [pickedName, setPickedName] = useState<string | null>(null)
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
  const clear = useCallback(() => setPickedName(null), [])
  const moreAccess = useCallback(() => {
    invalidateOrcaCloudGitHubRepositories()
    void window.api.orcaCloudWorkspace.connectGitHub()
  }, [])
  const start = useCallback(
    (request: { prompt: string; agent: string | null }) =>
      picked
        ? startCloudWorkspaceFromGitHub({
            repoUrl: picked.url,
            fullName: picked.fullName,
            ...request
          })
        : Promise.resolve(false),
    [picked]
  )
  return { repos, showMore, picked, githubStep, pick: setPickedName, clear, moreAccess, start }
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
  hoursToast,
  onClose
}: {
  cloudOnly: CloudOnlyRepo
  createWorkspace: () => void
  prompt: string
  agent: string | null
  profileId: string | null
  /** "Using sandbox hours · …", or null before billing answers. */
  hoursToast: string | null
  onClose?: () => void
}): () => void {
  const { picked, start } = cloudOnly
  return useCallback(() => {
    if (!picked) {
      createWorkspace()
      return
    }
    clearCloudStartDraft(profileId)
    if (hoursToast) {
      toast.message(hoursToast)
    }
    void start({ prompt, agent })
    onClose?.()
  }, [agent, createWorkspace, hoursToast, onClose, picked, profileId, prompt, start])
}
