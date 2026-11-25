import { foldWwwHostAlias, normalizeForgeWebHost } from './git-remote-host-alias'

type PublicForgeProvider = 'github' | 'gitlab' | 'bitbucket' | 'azure-devops' | 'gitea'

/** Ownership only: callers retain their original endpoint and persisted host identity. */
export function getPublicForgeProviderForHost(host: string): PublicForgeProvider | null {
  const hostname = normalizeForgeWebHost(foldWwwHostAlias(host).replace(/:\d+$/, ''))
  if (hostname === 'github.com' || hostname === 'ghe.com' || hostname.endsWith('.ghe.com')) {
    return 'github'
  }
  if (hostname === 'gitlab.com') {
    return 'gitlab'
  }
  if (hostname === 'bitbucket.org') {
    return 'bitbucket'
  }
  if (
    hostname === 'dev.azure.com' ||
    hostname.endsWith('.dev.azure.com') ||
    hostname.endsWith('.visualstudio.com')
  ) {
    return 'azure-devops'
  }
  return hostname === 'codeberg.org' ? 'gitea' : null
}
