// @protected-copy
import { useEffect, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import type { PluginUpdateReviewNotice } from '../../../../../shared/plugins/catalog/plugin-update-policy'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import { useTranslate } from '@/i18n/use-translate'
import { openPluginUpdateReviewDialog } from '@/store/plugins/updates/plugin-update-review-dialog'
import { Button } from '../../ui/button'
import { SecuritySurface } from '../../ui/security-surface'
import { pluginListEntryFromInstalled } from '../list/plugin-list-entries'
import { PluginRowArt } from '../list/PluginRowArt'
import {
  installUpdates,
  loadUpdate,
  requiredNewerOrca,
  type LoadedUpdate
} from '../state/plugin-update-approval'
import { useOrcaVersion } from '../state/use-plugin-page-navigation'
import { PluginUpdatePublisher, PluginUpdateVersions } from './PluginUpdateIdentity'
import { PluginUpdateAdditionList } from './PluginUpdateReview'
import { pluginUpdateAdditions } from './plugin-update-additions'

/** Plugins the toast shows; more than this goes to the dialog, with no approval in the toast. */
const SHOWN_PLUGINS = 3

type Loaded = {
  /** Missing when its preview couldn't be read. */
  updates: ReadonlyMap<string, LoadedUpdate>
  installed: ReadonlyMap<string, PluginHostListEntry>
}

function useLoadedNotices(notices: readonly PluginUpdateReviewNotice[]): Loaded | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  useEffect(() => {
    let stale = false
    void Promise.all([
      Promise.all(
        notices.map((notice) =>
          loadUpdate(notice.pluginKey)
            .then((update) => [[notice.pluginKey, update] as const])
            .catch(() => [])
        )
      ),
      window.api.plugins.list().catch((): PluginHostListEntry[] => [])
    ]).then(([updates, plugins]) => {
      if (!stale) {
        setLoaded({
          updates: new Map(updates.flat()),
          installed: new Map(plugins.map((plugin) => [plugin.pluginKey, plugin] as const))
        })
      }
    })
    return () => {
      stale = true
    }
  }, [notices])
  return loaded
}

function ToastPlugin({
  notice,
  update,
  installed
}: {
  notice: PluginUpdateReviewNotice
  update: LoadedUpdate | undefined
  installed: PluginHostListEntry | undefined
}): React.JSX.Element {
  const t = useTranslate()
  const { lines, compared } = update
    ? pluginUpdateAdditions(update.preview, update.installedManifest, t)
    : { lines: [], compared: true }
  return (
    <div data-plugin-update-toast={notice.pluginKey} className="space-y-1.5">
      <div className="flex items-center gap-2">
        {installed ? <PluginRowArt entry={pluginListEntryFromInstalled(installed)} /> : null}
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="truncate text-sm font-medium">
            {notice.name}
            {update ? (
              <PluginUpdateVersions from={installed?.version} preview={update.preview} />
            ) : (
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                {notice.version}
              </span>
            )}
          </p>
          {update ? (
            <PluginUpdatePublisher pluginKey={notice.pluginKey} preview={update.preview} />
          ) : null}
        </div>
      </div>
      {compared ? null : (
        <p className="text-xs text-muted-foreground">
          {t(
            'auto.components.settings.PluginUpdateReviewToast.uncompared',
            'Orca couldn’t compare it with the version you approved.'
          )}
        </p>
      )}
      {/* Why every line: "Approve & update" here approves all of it. */}
      {lines.length > 0 ? <PluginUpdateAdditionList lines={lines} className="text-xs" /> : null}
    </div>
  )
}

/**
 * Held updates, approvable in place: each plugin with its publisher and what it adds, "Approve &
 * update" to approve exactly that, or "Details" for the full review. Why the quick path only when
 * every update was read, compared and can install: otherwise the user needs the dialog.
 */
export function PluginUpdateReviewToast({
  notices,
  onResolved
}: {
  notices: readonly PluginUpdateReviewNotice[]
  /** These notices are handled: installed, dismissed, or handed to the dialog. */
  onResolved: (notices: readonly PluginUpdateReviewNotice[]) => void
}): React.JSX.Element {
  const t = useTranslate()
  const orcaVersion = useOrcaVersion()
  const loaded = useLoadedNotices(notices)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  // Why kept: a retry after a partial failure must not reinstall the ones that landed.
  const [landed, setLanded] = useState<ReadonlySet<string>>(() => new Set())

  const details = (): void => {
    onResolved(notices)
    openPluginUpdateReviewDialog(notices.map((notice) => notice.pluginKey))
  }
  const quick =
    loaded !== null &&
    notices.length <= SHOWN_PLUGINS &&
    notices.every(({ pluginKey }) => {
      const preview = loaded.updates.get(pluginKey)?.preview
      // Why the installed entry too: without it the toast can't show the version it replaces.
      return (
        preview !== undefined &&
        loaded.installed.has(pluginKey) &&
        preview.accessGrowth !== undefined &&
        !preview.blockedByKillList &&
        !requiredNewerOrca(preview, orcaVersion)
      )
    })
  const update = async (): Promise<void> => {
    if (!loaded) {
      return
    }
    setBusy(true)
    setFailure(null)
    const { approved, held, failed } = await installUpdates(
      notices.flatMap((notice) => {
        const preview = loaded.updates.get(notice.pluginKey)?.preview
        return preview && !landed.has(notice.pluginKey)
          ? [{ preview, name: notice.name, reviewed: true }]
          : []
      })
    )
    setLanded(
      new Set([...landed, ...[...approved, ...held].map(({ preview }) => preview.pluginKey)])
    )
    setBusy(false)
    if (failed.length === 0) {
      onResolved(notices)
      return
    }
    setFailure(
      t('auto.components.settings.PluginUpdateReviewToast.failed', 'Couldn’t update {{value0}}', {
        value0: failed.map(({ name }) => name).join(', ')
      })
    )
  }
  const [only] = notices
  // Why these keys: this file is protected copy, so a language pack can't soften the titles.
  const title =
    notices.length === 1 && only
      ? only.reason === 'repository'
        ? t(
            'auto.components.settings.PluginUpdateReviewToast.movedTitle',
            '{{value0}} {{value1}} comes from a different repository',
            { value0: only.name, value1: only.version }
          )
        : t(
            'auto.components.settings.PluginUpdateReviewToast.accessTitle',
            '{{value0}} {{value1}} wants more access',
            { value0: only.name, value1: only.version }
          )
      : t(
          'auto.components.settings.PluginUpdateReviewToast.manyTitle',
          '{{value0}} plugin updates need your review',
          { value0: notices.length }
        )

  return (
    <SecuritySurface>
      <div className="relative w-[360px] max-w-[calc(100vw-32px)] space-y-3 rounded-lg border border-(--notice-border) bg-popover p-3.5 text-popover-foreground shadow-notice">
        <div className="flex items-start justify-between gap-3">
          <p className="pt-1 text-sm font-semibold">{title}</p>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={() => onResolved(notices)}
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
                update={loaded.updates.get(notice.pluginKey)}
                installed={loaded.installed.get(notice.pluginKey)}
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
