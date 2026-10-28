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

/** Adding trusted Node main code crosses a consent boundary even when declared capabilities stay unchanged. */
export function canonicalizePluginConsent(
  manifest: PluginConsentSubject,
  contentIdentity?: string
): string {
  const capabilities = canonicalizeCapabilitySet(manifest.capabilities)
  const workerIdentity = manifest.main === undefined ? '' : '\0trusted-node-worker'
  // Instructional bytes later execute under user/agent authority; bind approval to immutable install/dev-tree identity.
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
