// @protected-copy
import { useEffect, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import type { PluginMarketplaceHostInstallPreview } from '../../../../../preload/api/plugins/plugin-host-api'
import type { PluginUpdateReviewNotice } from '../../../../../shared/plugins/catalog/plugin-update-policy'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { openPluginUpdateReviewDialog } from '@/store/plugins/updates/plugin-update-review-dialog'
import { Button } from '../../ui/button'
import { SecuritySurface } from '../../ui/security-surface'
import { pluginListEntryFromInstalled } from '../list/plugin-list-entries'
import { PluginRowArt } from '../list/PluginRowArt'
import { installReviewedUpdate, requiredNewerOrca } from '../state/plugin-update-approval'
import { useOrcaVersion } from '../state/use-plugin-page-navigation'
import { pluginExecutionProfile } from '../../../../../shared/plugins/contributions/plugin-execution-profile'
import { pluginPublisherNotice } from '../presentation/plugin-publisher-trust'
import { PluginNotOfficialWarning } from './PluginNotOfficialWarning'
import { PluginPublisherBadge } from './PluginConsentProvenance'
import { PluginUpdateAdditionList, pluginKeyOwner } from './PluginUpdateReview'
import { usePluginUpdateAdditions } from './use-plugin-update-additions'

/** Plugins the toast shows; more than this goes to the dialog, with no approval in the toast. */
const SHOWN_PLUGINS = 3

type Loaded = {
  previews: ReadonlyMap<string, PluginMarketplaceHostInstallPreview>
  installed: ReadonlyMap<string, PluginHostListEntry>
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
  installed
}: {
  notice: PluginUpdateReviewNotice
  preview: PluginMarketplaceHostInstallPreview | null
  installed: PluginHostListEntry | null
}): React.JSX.Element {
  const t = useTranslate()
  const { lines, compared, ready } = usePluginUpdateAdditions(installed, preview)
  const publisherNotice = preview
    ? pluginPublisherNotice({
        official: preview.official,
        execution: pluginExecutionProfile(preview.manifest),
        manifest: preview.manifest,
        types: null
      })
    : 'none'
  return (
    <div data-plugin-update-toast={notice.pluginKey} className="space-y-1.5">
      <div className="flex items-center gap-2">
        {installed ? <PluginRowArt entry={pluginListEntryFromInstalled(installed)} /> : null}
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="truncate text-sm font-medium">
            {notice.name}
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              {installed?.version ? `${installed.version} → ` : ''}
              {notice.version}
            </span>
          </p>
          <PluginPublisherBadge
            official={preview?.official ?? false}
            publisher={pluginKeyOwner(notice.pluginKey)}
          />
        </div>
      </div>
      {/* Why here too: approving in the toast must not skip the dialog's publisher warning. */}
      {publisherNotice !== 'none' ? (
        <PluginNotOfficialWarning
          notice={publisherNotice}
          publisher={pluginKeyOwner(notice.pluginKey)}
          moment="update"
        />
      ) : null}
      {preview && !compared ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'auto.components.settings.PluginUpdateReviewToast.uncompared',
            'Orca couldn’t compare it with the version you approved.'
          )}
        </p>
      ) : null}
      {/* Why every line: "Approve & update" here approves all of it. */}
      {ready && lines.length > 0 ? (
        <PluginUpdateAdditionList lines={lines} className="text-xs" />
      ) : null}
    </div>
  )
}

/**
 * Held updates, approvable in place: each plugin with its publisher and what it adds, "Update"
 * to approve exactly that, or "Details" for the full review. Why the quick path only when every
 * update was compared and can install: otherwise the user needs the dialog's full access list.
 */
export function PluginUpdateReviewToast({
  toastId,
  notices,
  onClose
}: {
  toastId: string | number
  notices: readonly PluginUpdateReviewNotice[]
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const orcaVersion = useOrcaVersion()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
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
      window.api.plugins.list().catch((): PluginHostListEntry[] => [])
    ]).then(([previews, plugins]) => {
      if (!stale) {
        setLoaded({
          previews: new Map(previews.flatMap((entry) => (entry ? [entry] : []))),
          installed: new Map(plugins.map((plugin) => [plugin.pluginKey, plugin] as const))
        })
      }
    })
    return () => {
      stale = true
    }
  }, [notices])

  const keys = notices.map((notice) => notice.pluginKey)
  const dismiss = (): void => {
    onClose()
    toast.dismiss(toastId)
  }
  const details = (): void => {
    dismiss()
    openPluginUpdateReviewDialog(keys)
  }
  const previews = loaded ? keys.map((key) => loaded.previews.get(key) ?? null) : []
  const quick =
    loaded !== null &&
    notices.length <= SHOWN_PLUGINS &&
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
    // Why sequential: each install re-reads the plugin list; parallel installs race that refresh.
    for (const [index, preview] of previews.entries()) {
      if (preview && !(await installReviewedUpdate(preview))) {
        failed.push(notices[index]?.name ?? preview.pluginKey)
      }
    }
    setBusy(false)
    if (failed.length > 0) {
      setFailure(
        t('auto.components.settings.PluginUpdateReviewToast.failed', 'Couldn’t update {{value0}}', {
          value0: failed.join(', ')
        })
      )
      return
    }
    dismiss()
    toast.success(
      notices.length === 1
        ? translate('auto.store.pluginAutoUpdates.one', '{{value0}} updated to {{value1}}', {
            value0: notices[0]?.name,
            value1: notices[0]?.version
          })
        : translate('auto.store.pluginAutoUpdates.many', '{{value0}} plugins updated', {
            value0: notices.length
          })
    )
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
