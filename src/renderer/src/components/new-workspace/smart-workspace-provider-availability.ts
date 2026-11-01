import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'

// Why: hosts that are certainly not Gitea; every other remote may be a self-hosted Gitea.
const NON_GITEA_REMOTE_HOSTS = new Set([
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'dev.azure.com',
  'ssh.dev.azure.com'
])

export function isLikelyGiteaRemoteHost(host: string | null | undefined): boolean {
  const normalized = host?.trim().toLowerCase()
  return normalized !== undefined && normalized !== '' && !NON_GITEA_REMOTE_HOSTS.has(normalized)
}

export function canUseGiteaSmartSource({
  giteaEnabled,
  localGiteaAvailable,
  repoBackedSourcesDisabled,
  remoteHost,
  sourceHostId
}: {
  giteaEnabled: boolean
  localGiteaAvailable: boolean
  repoBackedSourcesDisabled: boolean
  remoteHost: string | null | undefined
  sourceHostId: ExecutionHostId | null | undefined
}): boolean {
  if (!giteaEnabled || repoBackedSourcesDisabled || !isLikelyGiteaRemoteHost(remoteHost)) {
    return false
  }
  const parsedHost = parseExecutionHostId(sourceHostId)
  return parsedHost?.kind === 'ssh' || parsedHost?.kind === 'runtime' || localGiteaAvailable
}

export function canUseGitLabSmartSource({
  localGitlabAvailable,
  repoBackedSourcesDisabled,
  sourceHostId
}: {
  localGitlabAvailable: boolean
  repoBackedSourcesDisabled: boolean
  sourceHostId: ExecutionHostId | null | undefined
}): boolean {
  if (repoBackedSourcesDisabled) {
    return false
  }
  const parsedHost = parseExecutionHostId(sourceHostId)
  return parsedHost?.kind === 'ssh' || parsedHost?.kind === 'runtime' || localGitlabAvailable
}
