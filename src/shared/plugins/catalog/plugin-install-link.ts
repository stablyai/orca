import { isAllowedPluginGitUrl } from '../installation/plugin-install-lockfile'
import { isQualifiedPluginKey } from '../frames/plugin-tab-key'
import {
  isOfficialMarketplaceGitSource,
  isReservedPluginIdentity,
  type PluginMarketplaceGitSource
} from './plugin-marketplace'

export const PLUGIN_INSTALL_LINK_MAX_LENGTH = 2048
const CATALOG_URL_MAX_LENGTH = 512
const PLUGIN_INSTALL_LINK_PREFIX = 'orca://plugins'

export const COMMUNITY_MARKETPLACE_GIT_SOURCE: PluginMarketplaceGitSource = {
  kind: 'git',
  url: 'https://github.com/stablyai/orca-community-plugins.git',
  ref: 'main'
}

export type PluginInstallLinkCatalog =
  | { kind: 'official' }
  | { kind: 'community'; source: PluginMarketplaceGitSource }
  | { kind: 'url'; source: PluginMarketplaceGitSource }

export type PluginInstallLink = { pluginKey: string; catalog: PluginInstallLinkCatalog }

/** True for anything shaped like a plugin link, valid or not, so a malformed one still reaches the error toast. */
export function isPluginInstallLinkArgument(value: string): boolean {
  const lower = value
    .trim()
    .slice(0, PLUGIN_INSTALL_LINK_PREFIX.length + 1)
    .toLowerCase()
  return lower === `${PLUGIN_INSTALL_LINK_PREFIX}/` || lower === `${PLUGIN_INSTALL_LINK_PREFIX}?`
}

export function pluginInstallLinkFromArguments(argv: readonly string[]): string | null {
  const value = argv.find(isPluginInstallLinkArgument)
  // Why one past the cap: an oversized link must still fail parsing (and toast), not be trimmed valid.
  return value ? value.trim().slice(0, PLUGIN_INSTALL_LINK_MAX_LENGTH + 1) : null
}

function parseCatalog(value: string | null): PluginInstallLinkCatalog | null {
  if (value === null || value === 'official') {
    return { kind: 'official' }
  }
  if (value === 'community') {
    return { kind: 'community', source: COMMUNITY_MARKETPLACE_GIT_SOURCE }
  }
  if (value.length > CATALOG_URL_MAX_LENGTH || !isAllowedPluginGitUrl(value)) {
    return null
  }
  const source: PluginMarketplaceGitSource = { kind: 'git', url: value.trim(), ref: 'main' }
  return isOfficialMarketplaceGitSource(source.url) ? { kind: 'official' } : { kind: 'url', source }
}

/** `orca://plugins/<publisher.id>?catalog=<official|community|https or ssh URL>`; null when malformed. */
export function parsePluginInstallLink(value: string): PluginInstallLink | null {
  if (value.length > PLUGIN_INSTALL_LINK_MAX_LENGTH || !isPluginInstallLinkArgument(value)) {
    return null
  }
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  const match = /^\/([^/]+)\/?$/.exec(url.pathname)
  const pluginKey = match ? match[1]! : ''
  const catalogs = url.searchParams.getAll('catalog')
  if (url.hostname !== 'plugins' || url.hash || !isQualifiedPluginKey(pluginKey)) {
    return null
  }
  if (catalogs.length > 1 || [...url.searchParams.keys()].some((key) => key !== 'catalog')) {
    return null
  }
  const catalog = parseCatalog(catalogs[0] ?? null)
  // Why: reserved publishers install only from the official catalog, so another catalog is a spoof.
  if (!catalog || (catalog.kind !== 'official' && isReservedPluginIdentity(pluginKey))) {
    return null
  }
  return { pluginKey, catalog }
}
