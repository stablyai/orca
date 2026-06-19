import type { Project } from '../../../shared/types'

export function getProjectHostCloneUrl(project: Project | null | undefined): string | null {
  const identity = project?.providerIdentity
  if (!identity || identity.provider !== 'github') {
    return null
  }
  const owner = identity.owner.trim()
  const repo = identity.repo.trim()
  if (!owner || !repo) {
    return null
  }
  return `https://github.com/${owner}/${repo}.git`
}
