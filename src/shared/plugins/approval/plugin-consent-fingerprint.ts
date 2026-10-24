import { createHash } from 'node:crypto'
import { canonicalizeCapabilitySet } from '../plugin-capabilities'
import { pluginExecutionAllows, type PluginExecutionProfile } from '../plugin-execution-profile'
import type { PluginManifest } from '../manifest/plugin-manifest'

type PluginConsentSubject = Pick<PluginManifest, 'capabilities' | 'main'> & {
  execution?: PluginExecutionProfile
  contributes?: Partial<
    Pick<PluginManifest['contributes'], 'keybindings' | 'vmRecipes' | 'agents' | 'panels'>
  >
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

// Why v1 too: a worker or panel update must not swap code under an old approval, even though
// binding them re-prompts every existing install once.
function bindsExecutableContent(manifest: PluginConsentSubject): boolean {
  return manifest.execution === undefined
    ? manifest.main !== undefined || (manifest.contributes?.panels?.length ?? 0) > 0
    : pluginExecutionAllows(manifest.execution, 'sandboxed-ui')
}

/** Whether approval names exact package bytes, so any byte change needs a new review. */
export function requiresPluginContentApproval(manifest: PluginConsentSubject): boolean {
  return hasInstructionalPluginContributions(manifest) || bindsExecutableContent(manifest)
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
  const executableIdentity = bindsExecutableContent(manifest)
    ? `\0executable-content:${contentIdentity ?? 'unresolved'}`
    : ''
  // Instructional bytes execute later under user or agent authority, so
  // approval is bound to their immutable install/dev-tree identity.
  const instructionalIdentity = hasInstructionalPluginContributions(manifest)
    ? `\0instructional-content:${contentIdentity ?? 'unresolved'}`
    : ''
  return `${capabilities}${workerIdentity}${executableIdentity}${instructionalIdentity}`
}

export function fingerprintPluginConsent(
  manifest: PluginConsentSubject,
  contentIdentity?: string
): string {
  return `sha256-${createHash('sha256')
    .update(canonicalizePluginConsent(manifest, contentIdentity))
    .digest('base64')}`
}
