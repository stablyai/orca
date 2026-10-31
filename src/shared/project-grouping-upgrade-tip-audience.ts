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
    hostId: z.string(),
    checkoutCount: z.number().int().min(2)
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
  for (const setup of setups) {
    const checkoutCount =
      surfaces.get(`${setup.projectId}::${getProjectHostNamespace(setup)}`)?.size ?? 0
    if (checkoutCount > 1) {
      return {
        version: 1,
        membership: 'eligible',
        projectId: setup.projectId,
        hostId: setup.hostId,
        checkoutCount
      }
    }
  }
  return { version: 1, membership: 'excluded' }
}
