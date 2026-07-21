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
  const requestedHost = identity.host?.trim() || 'github.com'
  if (/[\\/@?#]/.test(requestedHost)) {
    return null
  }
  let host: string
  try {
    const parsed = new URL(`https://${requestedHost}`)
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return null
    }
    host = parsed.host
  } catch {
    return null
  }
  return `https://${host}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git`
}
