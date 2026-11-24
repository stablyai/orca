// @protected-copy
import { toast } from 'sonner'
import type { PluginMarketplaceHostInstallPreview } from '../../../../../preload/api/plugins/plugin-host-api'
import {
  satisfiesOrcaEngineRange,
  type PluginManifest
} from '../../../../../shared/plugins/manifest/plugin-manifest'
import { translate } from '@/i18n/i18n'
import {
  catalogInstallErrorMessage,
  isPluginCatalogUpdating
} from '../presentation/plugin-error-presentation'

/** An update as the review and the toast show it: the preview and the installed manifest its
 *  lines are named from. Read together so "Approve & update" never precedes what it approves. */
export type LoadedUpdate = {
  preview: PluginMarketplaceHostInstallPreview
  installedManifest: PluginManifest | null
}

/** Reads one held update; rejects when its preview can't be read. */
export async function loadUpdate(pluginKey: string): Promise<LoadedUpdate> {
  const [preview, installedManifest] = await Promise.all([
    window.api.plugins.previewMarketplaceUpdate({ pluginKey }),
    // Why null on failure: editor lines then stay generic instead of blocking the review.
    window.api.plugins.getInstalledManifest({ pluginKey }).catch((cause: unknown) => {
      console.warn('[plugins] installed manifest read failed:', cause)
      return null
    })
  ])
  return { preview, installedManifest }
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

/** One update to install. `reviewed`: the user approved what it adds, so approve its fingerprint. */
export type UpdateToInstall = {
  preview: PluginMarketplaceHostInstallPreview
  name: string
  reviewed: boolean
}

/**
 * `approved`: landed, and a reviewed one is approved. `held`: landed, but its bytes differ from the
 * reviewed ones or its approval was refused, so it waits for review. `failed`: install failed.
 */
export type UpdateResult = 'approved' | 'held' | 'failed'

async function installOne({
  preview,
  name,
  reviewed
}: UpdateToInstall): Promise<{ result: UpdateResult; error?: string; retryLater?: boolean }> {
  let installed = false
  try {
    const result = await window.api.plugins.installMarketplacePlugin({
      marketplaceSourceId: preview.marketplaceSourceId,
      marketplaceCommit: preview.marketplaceCommit,
      pluginKey: preview.pluginKey,
      resolvedCommit: preview.resolvedCommit
    })
    if (!result.ok) {
      return {
        result: 'failed',
        error: catalogInstallErrorMessage(result.error),
        retryLater: isPluginCatalogUpdating(result.error)
      }
    }
    installed = true
    if (!reviewed) {
      return result.needsReview
        ? {
            result: 'held',
            error: translate(
              'auto.components.settings.PluginUpdateReviewToast.needsReview',
              '{{value0}} installed and needs your review in Settings → Plugins.',
              { value0: name }
            )
          }
        : { result: 'approved' }
    }
    // Why only on a match: other bytes than the reviewed ones must be reviewed again.
    if (result.consentFingerprint !== preview.consentFingerprint) {
      return { result: 'held' }
    }
    await window.api.plugins.consent({
      pluginKey: preview.pluginKey,
      reviewedFingerprint: preview.consentFingerprint,
      decision: 'approve'
    })
    return { result: 'approved' }
  } catch (cause) {
    console.warn('[plugins] update failed:', cause)
    return {
      result: installed ? 'held' : 'failed',
      error: catalogInstallErrorMessage(cause),
      retryLater: !installed && isPluginCatalogUpdating(cause)
    }
  }
}

/**
 * Installs updates one by one and tells the user what landed. Why sequential: each install
 * re-reads the plugin list, and parallel installs race that refresh.
 */
export async function installUpdates(
  updates: readonly UpdateToInstall[]
): Promise<
  Record<UpdateResult, UpdateToInstall[]> & { unattempted: UpdateToInstall[]; error?: string }
> {
  const results: Record<UpdateResult, UpdateToInstall[]> = { approved: [], held: [], failed: [] }
  const unattempted: UpdateToInstall[] = []
  const heldMessages = new Map<UpdateToInstall, string>()
  let error: string | undefined
  for (const [index, update] of updates.entries()) {
    const attempt = await installOne(update)
    results[attempt.result].push(update)
    if (attempt.result === 'failed') {
      error ??= attempt.error
    }
    if (attempt.result === 'held' && attempt.error) {
      heldMessages.set(update, attempt.error)
    }
    if (attempt.retryLater) {
      error = attempt.error
      unattempted.push(...updates.slice(index + 1))
      break
    }
  }
  announceInstalled(results.approved, results.held, heldMessages)
  return { ...results, unattempted, error }
}

function announceInstalled(
  approved: readonly UpdateToInstall[],
  held: readonly UpdateToInstall[],
  heldMessages: ReadonlyMap<UpdateToInstall, string>
): void {
  const [one] = approved
  if (one) {
    toast.success(
      approved.length === 1
        ? translate('auto.store.pluginAutoUpdates.one', '{{value0}} updated to {{value1}}', {
            value0: one.name,
            value1: one.preview.manifest.version
          })
        : translate('auto.store.pluginAutoUpdates.many', '{{value0}} plugins updated', {
            value0: approved.length
          })
    )
  }
  for (const update of held) {
    const { name } = update
    // Why say so: the bytes changed after the review, so its approval doesn't apply.
    toast.warning(
      heldMessages.get(update) ??
        translate(
          'auto.components.settings.PluginUpdateReviewToast.held',
          '{{value0}} changed after you reviewed it, so it waits for your review in Settings → Plugins.',
          { value0: name }
        )
    )
  }
}
