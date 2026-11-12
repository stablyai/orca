import { toast } from 'sonner'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'

export function formatProjectPresenceProfileNames(profileNames: readonly string[]): string {
  const names = [...new Set(profileNames.map((name) => name.trim()).filter(Boolean))]
  if (names.length <= 3) {
    return names.join(', ')
  }
  // Why: the "+N more" overflow suffix is user-visible toast copy and must localize.
  return translate('auto.store.slices.repos.presenceProfileOverflow', '{{names}} +{{count}} more', {
    names: names.slice(0, 3).join(', '),
    count: names.length - 3
  })
}

export async function warnIfProjectKnownInAnotherProfile(
  repo: Repo,
  activeOrcaProfileId: string | null
): Promise<void> {
  const findProjectProfiles = window.api.orcaProfiles?.findProjectProfiles
  // Why: without an active profile ID the scan can't exclude the current profile and would false-positive on the just-added project.
  if (!findProjectProfiles || !activeOrcaProfileId) {
    return
  }
  try {
    const result = await findProjectProfiles({
      path: repo.path,
      connectionId: repo.connectionId ?? null,
      executionHostId: getRepoExecutionHostId(repo),
      excludeProfileId: activeOrcaProfileId
    })
    const description = formatProjectPresenceProfileNames(
      result.projects.map((project) => project.profileName)
    )
    if (!description) {
      return
    }
    toast.warning(
      translate('auto.store.slices.repos.2dcd706774', 'Project also exists in another profile'),
      { description }
    )
  } catch (err) {
    // Why: adding a project should not fail because an advisory profile scan failed.
    console.warn('Failed to check project presence in other profiles:', err)
  }
}
