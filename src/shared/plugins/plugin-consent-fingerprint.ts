import { createHash } from 'node:crypto'
import { canonicalizeCapabilitySet } from './plugin-capabilities'
import type { PluginManifest } from './plugin-manifest'

type PluginConsentSubject = Pick<PluginManifest, 'capabilities' | 'main'> & {
  contributes?: Partial<Pick<PluginManifest['contributes'], 'keybindings' | 'vmRecipes' | 'agents'>>
}

export function hasInstructionalPluginContributions(manifest: PluginConsentSubject): boolean {
  const contributions = manifest.contributes
  return Boolean(
    contributions &&
    ((contributions.keybindings?.length ?? 0) > 0 ||
      (contributions.vmRecipes?.length ?? 0) > 0 ||
      (contributions.agents?.length ?? 0) > 0)
  )
}

/**
 * Consent covers both the declared host capabilities and whether the plugin
 * executes trusted Node code. A panel-only update that adds `main` crosses a
 * trust boundary even when its capability list is unchanged.
 */
export function canonicalizePluginConsent(
  manifest: PluginConsentSubject,
  contentIdentity?: string
): string {
  const capabilities = canonicalizeCapabilitySet(manifest.capabilities)
  const workerIdentity = manifest.main === undefined ? '' : '\0trusted-node-worker'
  // Instructional bytes execute later under user or agent authority, so
  // approval is bound to their immutable install/dev-tree identity.
  const instructionalIdentity = hasInstructionalPluginContributions(manifest)
    ? `\0instructional-content:${contentIdentity ?? 'unresolved'}`
    : ''
  return `${capabilities}${workerIdentity}${instructionalIdentity}`
}

export function fingerprintPluginConsent(
  manifest: PluginConsentSubject,
  contentIdentity?: string
): string {
  return `sha256-${createHash('sha256')
    .update(canonicalizePluginConsent(manifest, contentIdentity))
    .digest('base64')}`
}
