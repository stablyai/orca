import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type {
  PluginMarketplaceHostInstallPreview,
  PluginMarketplaceHostListing
} from '../../../../../preload/api-types'
import { pluginExecutionProfile } from '../../../../../shared/plugins/contributions/plugin-execution-profile'
import { translate } from '@/i18n/i18n'
import { pluginInstallErrorMessage } from '../presentation/plugin-error-presentation'
import { PLUGIN_ACTION_TOAST_DURATION_MS } from './plugin-action-toast'
import { applyPluginThemesNow } from './plugin-theme-apply'
import { pluginTryAction } from './plugin-try-action'
import type { PluginPagePreview } from './use-plugin-catalog'
import { previewMatchesListing } from './use-plugin-page-model'

export type PluginInstallPhase = { kind: 'installing' } | { kind: 'error'; message: string }

// Why the `plugin` key prefix: install errors are security copy language packs may not rewrite.
function catalogInstallErrorMessage(cause: unknown): string {
  const detail = (cause instanceof Error ? cause.message : String(cause)).toLowerCase()
  if (/(do not match|does not match|no longer matches)/.test(detail)) {
    return translate(
      'auto.components.settings.pluginInstallAction.mismatch',
      'Download didn’t match the catalog. Nothing installed.'
    )
  }
  if (detail.includes('marketplace changed')) {
    return translate(
      'auto.components.settings.pluginInstallAction.catalogChanged',
      'The catalog changed. Refresh and try again.'
    )
  }
  if (detail.includes('safety list')) {
    return translate(
      'auto.components.settings.pluginInstallAction.blocked',
      'Orca’s safety list blocks this plugin.'
    )
  }
  return pluginInstallErrorMessage(cause)
}

const downloadFailed = (): string =>
  translate(
    'auto.components.settings.pluginInstallAction.downloadFailed',
    'Couldn’t download. Check your connection.'
  )

/**
 * One action to install a catalog plugin, shared by its card and its page. Main turns a plugin on
 * only when its verified manifest is content only; for anything else this approves exactly the
 * fingerprint the page showed, and main refuses if what installed differs.
 */
export function usePluginInstallAction({
  fetchPreview,
  onInstalled,
  isFromInstallLink
}: {
  fetchPreview: (listing: PluginMarketplaceHostListing) => Promise<PluginPagePreview>
  /** Reloads the list; opens review on the page for any plugin still waiting for it. */
  onInstalled: (pluginKey: string) => Promise<void>
  /** Whether this install is on the page an install link opened; only labels telemetry. */
  isFromInstallLink?: (pluginKey: string) => boolean
}): {
  phaseOf: (pluginKey: string) => PluginInstallPhase | null
  install: (
    listing: PluginMarketplaceHostListing,
    /** The page's consent: approve this fingerprint after install. Absent for content only. */
    approve?: { preview: PluginMarketplaceHostInstallPreview }
  ) => Promise<void>
  dismiss: (pluginKey: string) => void
} {
  const [phases, setPhases] = useState<Readonly<Record<string, PluginInstallPhase>>>({})
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const setPhase = useCallback((pluginKey: string, phase: PluginInstallPhase | null) => {
    if (!mountedRef.current) {
      return
    }
    setPhases((current) => {
      const next = { ...current }
      if (phase) {
        next[pluginKey] = phase
      } else {
        delete next[pluginKey]
      }
      return next
    })
  }, [])

  const dismiss = useCallback((pluginKey: string) => setPhase(pluginKey, null), [setPhase])

  const install = useCallback(
    async (
      listing: PluginMarketplaceHostListing,
      approve?: { preview: PluginMarketplaceHostInstallPreview }
    ): Promise<void> => {
      const pluginKey = listing.pluginKey
      dismiss(pluginKey)
      setPhase(pluginKey, { kind: 'installing' })
      const read = approve
        ? { ok: true as const, preview: approve.preview }
        : await fetchPreview(listing)
      if (!read.ok) {
        setPhase(pluginKey, { kind: 'error', message: downloadFailed() })
        return
      }
      const { preview } = read
      // Why: preview reads the current catalog; never install a release other than the one shown.
      if (!previewMatchesListing(preview, listing)) {
        setPhase(pluginKey, {
          kind: 'error',
          message: catalogInstallErrorMessage(new Error('marketplace changed'))
        })
        return
      }
      const execution = listing.release?.execution ?? pluginExecutionProfile(preview.manifest)
      try {
        const result = await window.api.plugins.installMarketplacePlugin({
          marketplaceSourceId: preview.marketplaceSourceId,
          marketplaceCommit: preview.marketplaceCommit,
          pluginKey,
          resolvedCommit: preview.resolvedCommit,
          ...(isFromInstallLink?.(pluginKey) ? { fromInstallLink: true as const } : {}),
          // Why the fingerprint: main turns on only the exact bytes this preview showed.
          ...(execution === 'data'
            ? { enableIfData: true as const, expectedFingerprint: preview.consentFingerprint }
            : {})
        })
        if (!result.ok) {
          throw new Error(result.error)
        }
        // Why recipes wait: their command lines are read from the installed files, so they are
        // reviewed on the page after install rather than approved unseen.
        if (
          approve &&
          execution !== 'data' &&
          preview.manifest.contributes.vmRecipes.length === 0
        ) {
          await window.api.plugins
            .consent({
              pluginKey,
              reviewedFingerprint: approve.preview.consentFingerprint,
              decision: 'approve'
            })
            .catch((cause: unknown) => {
              // Why: a mismatch leaves it pending, and the page then shows what it now asks for.
              console.warn('[plugins] approval after install was refused:', cause)
            })
        }
        await onInstalled(pluginKey)
        setPhase(pluginKey, null)
        const { themes, iconThemes, terminalThemes } = preview.manifest.contributes
        const themed = themes.length + iconThemes.length + terminalThemes.length > 0
        // Why: a click to install a theme should show it at once; its toast offers Switch back.
        if (themed && (await applyPluginThemesNow(pluginKey).catch(() => false))) {
          return
        }
        // Why: only a plugin that is on by now has anything to try; recipes still wait for review.
        const on =
          execution === 'data' || (approve && preview.manifest.contributes.vmRecipes.length === 0)
        const tryIt = on ? pluginTryAction(pluginKey, preview.manifest) : null
        toast.success(
          translate(
            'auto.components.settings.pluginInstallAction.installed',
            '{{value0}} installed',
            { value0: preview.manifest.name }
          ),
          {
            duration: PLUGIN_ACTION_TOAST_DURATION_MS,
            action: tryIt
              ? {
                  label: translate('auto.components.settings.pluginInstallAction.tryIt', 'Try it'),
                  onClick: tryIt
                }
              : undefined
          }
        )
      } catch (cause) {
        console.warn('[plugins] catalog install failed:', cause)
        setPhase(pluginKey, { kind: 'error', message: catalogInstallErrorMessage(cause) })
      }
    },
    [dismiss, fetchPreview, isFromInstallLink, onInstalled, setPhase]
  )

  const phaseOf = useCallback(
    (pluginKey: string): PluginInstallPhase | null => phases[pluginKey] ?? null,
    [phases]
  )
  return { phaseOf, install, dismiss }
}
