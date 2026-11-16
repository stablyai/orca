import type { PluginMarketplaceHostInstallPreview } from '../../../../../preload/api/plugins/plugin-host-api'
import { satisfiesOrcaEngineRange } from '../../../../../shared/plugins/manifest/plugin-manifest'

/** `held`: installed, but its bytes differ from the reviewed ones, so it waits for review. */
export type ReviewedUpdateResult = 'approved' | 'held' | 'failed'

/**
 * Installs the reviewed release, then approves exactly the fingerprint the user was shown. Why only
 * on a match: other bytes than the reviewed ones wait for review on the plugin's page.
 */
export async function installReviewedUpdate(
  preview: PluginMarketplaceHostInstallPreview
): Promise<ReviewedUpdateResult> {
  try {
    const result = await window.api.plugins.installMarketplacePlugin({
      marketplaceSourceId: preview.marketplaceSourceId,
      marketplaceCommit: preview.marketplaceCommit,
      pluginKey: preview.pluginKey,
      resolvedCommit: preview.resolvedCommit
    })
    if (!result.ok) {
      return 'failed'
    }
    if (result.consentFingerprint !== preview.consentFingerprint) {
      return 'held'
    }
    await window.api.plugins.consent({
      pluginKey: preview.pluginKey,
      reviewedFingerprint: preview.consentFingerprint,
      decision: 'approve'
    })
    return 'approved'
  } catch (cause) {
    console.warn('[plugins] reviewed update failed:', cause)
    return 'failed'
  }
}

/** Installs an update that asks for nothing new; approval carries over in main. */
export async function installUpdate(
  preview: PluginMarketplaceHostInstallPreview
): Promise<boolean> {
  try {
    const result = await window.api.plugins.installMarketplacePlugin({
      marketplaceSourceId: preview.marketplaceSourceId,
      marketplaceCommit: preview.marketplaceCommit,
      pluginKey: preview.pluginKey,
      resolvedCommit: preview.resolvedCommit
    })
    return result.ok
  } catch (cause) {
    console.warn('[plugins] update failed:', cause)
    return false
  }
}

/** The update's minimum Orca when this Orca can't run it; null when it can or either is unknown. */
export function requiredNewerOrca(
  preview: PluginMarketplaceHostInstallPreview,
  orcaVersion: string | null | undefined
): string | null {
  const range = preview.manifest.engines?.orca
  if (!range || !orcaVersion || satisfiesOrcaEngineRange(orcaVersion, range)) {
    return null
  }
  return range.replace(/^>=/, '')
}
