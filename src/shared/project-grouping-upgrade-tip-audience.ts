import { z } from 'zod'
import type { Repo } from './repo-types'
import { projectHostSetupProjectionFromRepos } from './project-host-setup-projection'
import {
  getProjectCheckoutPathKey,
  getProjectHostNamespace,
  resolveProjectGroupingMode
} from './project-grouping'
import type { ProjectGroupingSettings } from './project-grouping'

const Audience = z.discriminatedUnion('membership', [
  z.object({ version: z.literal(1), membership: z.literal('excluded') }),
  z.object({
    version: z.literal(1),
    membership: z.literal('eligible'),
    projectId: z.string(),
    projectCount: z.number().int().min(1)
  })
])
export type ProjectGroupingUpgradeTipAudience = z.infer<typeof Audience>

export function parseProjectGroupingUpgradeTipAudience(
  value: unknown
): ProjectGroupingUpgradeTipAudience | null {
  const result = Audience.safeParse(value)
  return result.success ? result.data : null
}

export function captureProjectGroupingUpgradeTipAudience(
  repos: readonly Repo[],
  settings: ProjectGroupingSettings
): ProjectGroupingUpgradeTipAudience {
  const { setups } = projectHostSetupProjectionFromRepos(repos)
  const surfaces = new Map<string, Set<string>>()
  for (const setup of setups) {
    if (
      setup.projectId.startsWith('repo:') ||
      setup.kind === 'folder' ||
      setup.setupMethod === 'provisioned' ||
      resolveProjectGroupingMode(setup.projectId, settings) !== 'repository'
    ) {
      continue
    }
    const key = `${setup.projectId}::${getProjectHostNamespace(setup)}`
    const paths = surfaces.get(key) ?? new Set<string>()
    paths.add(getProjectCheckoutPathKey(setup))
    surfaces.set(key, paths)
  }
  const projectIds = new Set<string>()
  for (const setup of setups) {
    if ((surfaces.get(`${setup.projectId}::${getProjectHostNamespace(setup)}`)?.size ?? 0) > 1) {
      projectIds.add(setup.projectId)
    }
  }
  const [projectId] = projectIds
  if (projectId) {
    return { version: 1, membership: 'eligible', projectId, projectCount: projectIds.size }
  }
  return { version: 1, membership: 'excluded' }
}
