import { pluginRepositoryOrigin } from '../catalog/plugin-repository-link'
import { gitUrlPluginPublisher } from './plugin-publisher-derivation'

/** Where a CLI install comes from, as Orca read it; shown so a person can judge the author. */
export type PluginInstallSourceInfo = {
  kind: 'catalog' | 'git' | 'local-path'
  /** Only Orca's official catalog vouches for an author. */
  official: boolean
  /** The publisher Orca installs as: the repository owner or the catalog listing, never the manifest. */
  publisher: string | null
  /** `host/owner/repo` parsed by Orca from the URL it downloads. */
  repository: string | null
  url: string | null
  ref: string | null
  /** The exact commit the files come from; null for a local folder. */
  commit: string | null
  /** A local folder on the Orca host. */
  path: string | null
  catalog: { id: string; name: string; url: string; official: boolean } | null
}

export function gitInstallSourceInfo(input: {
  url: string
  ref: string
  commit: string
  path?: string
  publisher: string | null
}): PluginInstallSourceInfo {
  return {
    kind: 'git',
    official: false,
    publisher: input.publisher ?? gitUrlPluginPublisher(input.url),
    repository: pluginRepositoryOrigin(input.url, input.path)?.repository ?? null,
    url: input.url,
    ref: input.ref,
    commit: input.commit,
    path: null,
    catalog: null
  }
}

export function localInstallSourceInfo(path: string, publisher: string): PluginInstallSourceInfo {
  return {
    kind: 'local-path',
    official: false,
    publisher,
    repository: null,
    url: null,
    ref: null,
    commit: null,
    path,
    catalog: null
  }
}

/** Who the reader must trust, matching the app's "Make sure you trust …" dialog. */
function trustee(source: PluginInstallSourceInfo): string {
  const owner = source.url ? pluginRepositoryOrigin(source.url)?.owner : null
  return owner ?? source.publisher ?? source.repository ?? source.url ?? 'its author'
}

/** Lines naming the source; non-official ones add the same warning the install dialog gives. */
export function pluginInstallSourceLines(source: PluginInstallSourceInfo): string[] {
  const lines: string[] = []
  if (source.kind === 'local-path') {
    lines.push(`Source: the folder ${source.path ?? '(unknown)'} on the Orca host.`)
  } else {
    const at = source.commit ? ` at commit ${source.commit.slice(0, 12)}` : ''
    const ref = source.ref && source.ref !== source.commit ? ` (${source.ref})` : ''
    lines.push(`Source: ${source.repository ?? source.url ?? 'unknown repository'}${ref}${at}.`)
  }
  if (source.catalog) {
    lines.push(
      `Listed by: ${source.catalog.name || source.catalog.url}${source.catalog.official ? " (Orca's official catalog)" : ''}.`
    )
  }
  if (source.publisher) {
    lines.push(`Publisher: ${source.publisher}.`)
  }
  if (source.official) {
    return lines
  }
  lines.push(
    source.kind === 'local-path'
      ? 'Make sure you trust this folder: Orca has not checked it, so only install it if you trust where it came from.'
      : `Make sure you trust ${trustee(source)}: this plugin is not from Orca and Orca has not checked this repository, so only install it if you trust ${trustee(source)}.`
  )
  return lines
}
