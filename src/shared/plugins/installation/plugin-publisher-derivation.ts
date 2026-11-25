import { isSafePluginId } from './plugin-id-format'
import { parseGitRepositoryIdentity } from '../catalog/plugin-marketplace'

/**
 * Orca names a plugin's publisher after where the plugin comes from, the way a Go module path is
 * its repository path: a catalog listing names it (Stably's catalogs use the repository owner), a
 * Git URL install uses the URL's owner, and a local folder uses `local`. The manifest's own
 * `publisher` is deprecated and never decides identity for a catalog or Git install.
 */
export const LOCAL_PLUGIN_PUBLISHER = 'local'

/** Repository owner of a Git URL as a publisher slug (`github.com/Acme/x` → `acme`). */
export function gitUrlPluginPublisher(url: string): string | null {
  const owner = parseGitRepositoryIdentity(url)?.owner
  if (!owner) {
    return null
  }
  // Why fold `.` and `_`: GitLab allows them in owner names, plugin slugs do not.
  const slug = owner
    .toLowerCase()
    .replace(/[._]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return isSafePluginId(slug) ? slug : null
}

/** Local and dev folders keep a declared publisher while it is deprecated, so existing dev
 *  setups keep their identity, approvals and storage; otherwise they are `local`. */
export function localPluginPublisher(declared: string | undefined): string {
  return declared ?? LOCAL_PLUGIN_PUBLISHER
}

/** The manifest as Orca uses it: `publisher` is the derived one, whatever the file declared. */
export function withPluginPublisher<Manifest extends { publisher?: string }>(
  manifest: Manifest,
  publisher: string
): Manifest & { publisher: string } {
  return { ...manifest, publisher }
}
