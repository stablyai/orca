import { createHash } from 'node:crypto'
import { canonicalizeCapabilitySet } from '../capabilities/plugin-capabilities'
import {
  pluginExecutionAllows,
  type PluginExecutionProfile
} from '../contributions/plugin-execution-profile'
import type { PluginManifest } from '../manifest/plugin-manifest'
import {
  PLUGIN_CONTRIBUTION_POINT_POLICY,
  PLUGIN_CONTRIBUTION_POINTS,
  type PluginContributionPoint
} from '../contributions/plugin-contribution-points'

type PluginConsentSubject = Pick<PluginManifest, 'capabilities' | 'main'> & {
  execution?: PluginExecutionProfile
  contributes?: Partial<Record<PluginContributionPoint, readonly unknown[]>>
}

// Why from the policy table: a new point must decide here, not be missed by a hand-kept list.
const CONTENT_BOUND_POINTS = PLUGIN_CONTRIBUTION_POINTS.filter(
  (point) => PLUGIN_CONTRIBUTION_POINT_POLICY[point].bindsContent
)

export function hasDeclarativePluginContributions(manifest: PluginConsentSubject): boolean {
  return CONTENT_BOUND_POINTS.some((point) => (manifest.contributes?.[point]?.length ?? 0) > 0)
}

// Why v1 too: a worker or panel update must not swap code under an old approval, even though
// binding them re-prompts every existing install once.
function bindsExecutableContent(manifest: PluginConsentSubject): boolean {
  return manifest.execution === undefined
    ? manifest.main !== undefined ||
        (manifest.contributes?.panels?.length ?? 0) > 0 ||
        (manifest.contributes?.customEditors?.length ?? 0) > 0
    : pluginExecutionAllows(manifest.execution, 'sandboxed-ui')
}

/** Whether approval names exact package bytes, so any byte change needs a new review. */
export function requiresPluginContentApproval(manifest: PluginConsentSubject): boolean {
  return hasDeclarativePluginContributions(manifest) || bindsExecutableContent(manifest)
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
  // Why: a data pack that becomes declarative (e.g. adds alias commands) binds no new bytes, yet
  // crossed the one-click boundary. Data stays out so content packs keep their approval.
  const executionIdentity =
    manifest.execution === undefined || manifest.execution === 'data'
      ? ''
      : `\0execution:${manifest.execution}`
  const workerIdentity = manifest.main === undefined ? '' : '\0trusted-node-worker'
  const executableIdentity = bindsExecutableContent(manifest)
    ? `\0executable-content:${contentIdentity ?? 'unresolved'}`
    : ''
  // Declarative bytes execute later under user or agent authority, so
  // approval is bound to their immutable install/dev-tree identity.
  const declarativeIdentity = hasDeclarativePluginContributions(manifest)
    ? `\0instructional-content:${contentIdentity ?? 'unresolved'}`
    : ''
  return `${capabilities}${executionIdentity}${workerIdentity}${executableIdentity}${declarativeIdentity}`
}

export function fingerprintPluginConsent(
  manifest: PluginConsentSubject,
  contentIdentity?: string
): string {
  return `sha256-${createHash('sha256')
    .update(canonicalizePluginConsent(manifest, contentIdentity))
    .digest('base64')}`
}
