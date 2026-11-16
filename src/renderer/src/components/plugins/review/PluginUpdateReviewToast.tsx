// @protected-copy
import { useEffect, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import type { PluginMarketplaceHostInstallPreview } from '../../../../../preload/api/plugins/plugin-host-api'
import type { PluginUpdateReviewNotice } from '../../../../../shared/plugins/catalog/plugin-update-policy'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import type { PluginManifest } from '../../../../../shared/plugins/manifest/plugin-manifest'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { openPluginUpdateReviewDialog } from '@/store/plugins/updates/plugin-update-review-dialog'
import { Button } from '../../ui/button'
import { SecuritySurface } from '../../ui/security-surface'
import { pluginListEntryFromInstalled } from '../list/plugin-list-entries'
import { PluginRowArt } from '../list/PluginRowArt'
import { installReviewedUpdate, requiredNewerOrca } from '../state/plugin-update-approval'
import { useOrcaVersion } from '../state/use-plugin-page-navigation'
import { PluginUpdatePublisher, PluginUpdateVersions } from './PluginUpdateIdentity'
import { PluginUpdateAdditionList } from './PluginUpdateReview'
import { pluginUpdateAdditions, readInstalledManifest } from './plugin-update-additions'

/** Plugins the toast shows; more than this goes to the dialog, with no approval in the toast. */
const SHOWN_PLUGINS = 3

type Loaded = {
  previews: ReadonlyMap<string, PluginMarketplaceHostInstallPreview>
  installed: ReadonlyMap<string, PluginHostListEntry>
  manifests: ReadonlyMap<string, PluginManifest | null>
}

// Why settings.Plugin keys: that namespace is protected, so a language pack cannot soften the warning.
function singleTitle(notice: PluginUpdateReviewNotice): string {
  const values = { value0: notice.name, value1: notice.version }
  return notice.reason === 'repository'
    ? translate(
        'auto.components.settings.PluginUpdateReviewToast.movedTitle',
        '{{value0}} {{value1}} comes from a different repository',
        values
      )
    : translate(
        'auto.components.settings.PluginUpdateReviewToast.accessTitle',
        '{{value0}} {{value1}} wants more access',
        values
      )
}

function ToastPlugin({
  notice,
  preview,
  installed,
  installedManifest
}: {
  notice: PluginUpdateReviewNotice
  preview: PluginMarketplaceHostInstallPreview | null
  installed: PluginHostListEntry | null
  installedManifest: PluginManifest | null
}): React.JSX.Element {
  const t = useTranslate()
  const { lines, compared } = preview
    ? pluginUpdateAdditions(preview, installedManifest, t)
    : { lines: [], compared: true }
  return (
    <div data-plugin-update-toast={notice.pluginKey} className="space-y-1.5">
      <div className="flex items-center gap-2">
        {installed ? <PluginRowArt entry={pluginListEntryFromInstalled(installed)} /> : null}
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="truncate text-sm font-medium">
            {notice.name}
            {preview ? (
              <PluginUpdateVersions from={installed?.version} preview={preview} />
            ) : (
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                {notice.version}
              </span>
            )}
          </p>
          {preview ? (
            <PluginUpdatePublisher pluginKey={notice.pluginKey} preview={preview} />
          ) : null}
        </div>
      </div>
      {preview && !compared ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'auto.components.settings.PluginUpdateReviewToast.uncompared',
            'Orca couldn’t compare it with the version you approved.'
          )}
        </p>
      ) : null}
      {/* Why every line: "Approve & update" here approves all of it. */}
      {lines.length > 0 ? <PluginUpdateAdditionList lines={lines} className="text-xs" /> : null}
    </div>
  )
}

function announceInstalled(
  approved: readonly PluginUpdateReviewNotice[],
  held: readonly PluginUpdateReviewNotice[]
): void {
  const [one] = approved
  if (one) {
    toast.success(
      approved.length === 1
        ? translate('auto.store.pluginAutoUpdates.one', '{{value0}} updated to {{value1}}', {
            value0: one.name,
            value1: one.version
          })
        : translate('auto.store.pluginAutoUpdates.many', '{{value0}} plugins updated', {
            value0: approved.length
          })
    )
  }
  for (const notice of held) {
    // Why say so: the bytes changed after the toast read them, so the reviewed approval doesn't apply.
    toast.warning(
      translate(
        'auto.components.settings.PluginUpdateReviewToast.held',
        '{{value0}} changed after you reviewed it, so it waits for your review in Settings → Plugins.',
        { value0: notice.name }
      )
    )
  }
}

/**
 * Held updates, approvable in place: each plugin with its publisher and what it adds, "Update"
 * to approve exactly that, or "Details" for the full review. Why the quick path only when every
 * update was compared and can install: otherwise the user needs the dialog's full access list.
 */
export function PluginUpdateReviewToast({
  notices,
  onResolved
}: {
  notices: readonly PluginUpdateReviewNotice[]
  /** These notices are handled (installed, dismissed, or handed to the dialog). */
  onResolved: (notices: readonly PluginUpdateReviewNotice[]) => void
}): React.JSX.Element {
  const t = useTranslate()
  const orcaVersion = useOrcaVersion()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  // Why kept: a retry after a partial failure must not reinstall the ones that landed.
  const [finished, setFinished] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    let stale = false
    void Promise.all([
      Promise.all(
        notices.map((notice) =>
          window.api.plugins
            .previewMarketplaceUpdate({ pluginKey: notice.pluginKey })
            .then((preview) => [notice.pluginKey, preview] as const)
            .catch(() => null)
        )
      ),
      window.api.plugins.list().catch((): PluginHostListEntry[] => []),
      Promise.all(
        notices.map(
          async (notice) =>
            [notice.pluginKey, await readInstalledManifest(notice.pluginKey)] as const
        )
      )
    ]).then(([previews, plugins, manifests]) => {
      if (!stale) {
        setLoaded({
          previews: new Map(previews.flatMap((entry) => (entry ? [entry] : []))),
          installed: new Map(plugins.map((plugin) => [plugin.pluginKey, plugin] as const)),
          manifests: new Map(manifests)
        })
      }
    })
    return () => {
      stale = true
    }
  }, [notices])

  const keys = notices.map((notice) => notice.pluginKey)
  const dismiss = (): void => onResolved(notices)
  const details = (): void => {
    onResolved(notices)
    openPluginUpdateReviewDialog(keys)
  }
  const previews = loaded ? keys.map((key) => loaded.previews.get(key) ?? null) : []
  const quick =
    loaded !== null &&
    notices.length <= SHOWN_PLUGINS &&
    // Why the installed entry too: without it the toast can't name the source or what was held.
    keys.every((key) => loaded.installed.has(key)) &&
    previews.every(
      (preview) =>
        preview !== null &&
        preview.accessGrowth !== undefined &&
        !preview.blockedByKillList &&
        !requiredNewerOrca(preview, orcaVersion)
    )
  const update = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    const failed: string[] = []
    const approved: PluginUpdateReviewNotice[] = []
    const held: PluginUpdateReviewNotice[] = []
    const landed = new Set(finished)
    // Why sequential: each install re-reads the plugin list; parallel installs race that refresh.
    for (const [index, notice] of notices.entries()) {
      const preview = previews[index]
      if (!preview || landed.has(notice.pluginKey)) {
        continue
      }
      const result = await installReviewedUpdate(preview)
      if (result === 'failed') {
        failed.push(notice.name)
        continue
      }
      landed.add(notice.pluginKey)
      ;(result === 'approved' ? approved : held).push(notice)
    }
    setFinished(landed)
    setBusy(false)
    announceInstalled(approved, held)
    if (failed.length > 0) {
      setFailure(
        t('auto.components.settings.PluginUpdateReviewToast.failed', 'Couldn’t update {{value0}}', {
          value0: failed.join(', ')
        })
      )
      return
    }
    onResolved(notices)
  }
  const [only] = notices

  return (
    <SecuritySurface>
      <div className="relative w-[360px] max-w-[calc(100vw-32px)] space-y-3 rounded-lg border border-(--notice-border) bg-popover p-3.5 text-popover-foreground shadow-notice">
        <div className="flex items-start justify-between gap-3">
          <p className="pt-1 text-sm font-semibold">
            {notices.length === 1 && only
              ? singleTitle(only)
              : t(
                  'auto.components.settings.PluginUpdateReviewToast.manyTitle',
                  '{{value0}} plugin updates need your review',
                  { value0: notices.length }
                )}
          </p>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={dismiss}
            disabled={busy}
            aria-label={t('auto.components.settings.PluginUpdateReviewToast.dismiss', 'Dismiss')}
          >
            <X className="size-3.5" />
          </Button>
        </div>
        {loaded === null ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <div className="space-y-3">
            {notices.slice(0, SHOWN_PLUGINS).map((notice) => (
              <ToastPlugin
                key={notice.pluginKey}
                notice={notice}
                preview={loaded.previews.get(notice.pluginKey) ?? null}
                installed={loaded.installed.get(notice.pluginKey) ?? null}
                installedManifest={loaded.manifests.get(notice.pluginKey) ?? null}
              />
            ))}
            {notices.length > SHOWN_PLUGINS ? (
              <p className="text-xs text-muted-foreground">
                {t(
                  'auto.components.settings.PluginUpdateReviewToast.morePlugins',
                  'and {{value0}} more plugins',
                  { value0: notices.length - SHOWN_PLUGINS }
                )}
              </p>
            ) : null}
          </div>
        )}
        {failure ? (
          <p role="alert" className="text-xs text-destructive">
            {failure}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={details}>
            {t('auto.components.settings.PluginUpdateReviewToast.details', 'Details')}
          </Button>
          {quick ? (
            <Button size="sm" disabled={busy} onClick={() => void update()}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              {notices.length === 1
                ? t(
                    'auto.components.settings.PluginUpdateReviewToast.approveOne',
                    'Approve & update'
                  )
                : t(
                    'auto.components.settings.PluginUpdateReviewToast.approveAll',
                    'Approve & update all'
                  )}
            </Button>
          ) : null}
        </div>
      </div>
    </SecuritySurface>
  )
}
