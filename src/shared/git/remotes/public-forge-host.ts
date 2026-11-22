import { foldWwwHostAlias, normalizeForgeWebHost } from './git-remote-host-alias'

type PublicForgeProvider =
  | 'github'
  | 'gitlab'
  | 'bitbucket'
  | 'azure-devops'
  | 'gitea'
  | 'cnb'
  | 'atomgit'
  | 'gitee'

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
  // Fork: China-hosted forges (recognition only — clone/push never needed this). The gateway
  // still routes their URLs through plain git, so these names only affect display and links.
  if (hostname === 'cnb.cool' || hostname.endsWith('.cnb.cool')) {
    return 'cnb'
  }
  if (hostname === 'atomgit.com') {
    return 'atomgit'
  }
  return hostname === 'gitee.com' ? 'gitee' : null
}
