// @protected-copy
import type { PluginUpdateReviewNotice } from '../../../../../shared/plugins/catalog/plugin-update-policy'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import { useTranslate } from '@/i18n/use-translate'
import { pluginListEntryFromInstalled } from '../list/plugin-list-entries'
import { PluginRowArt } from '../list/PluginRowArt'
import type { LoadedUpdate } from '../state/plugin-update-approval'
import { PluginUpdatePublisher, PluginUpdateVersions } from './PluginUpdateIdentity'
import { PluginUpdateAdditionList } from './PluginUpdateReview'
import { pluginUpdateAdditions } from './plugin-update-additions'

export function PluginUpdateReviewToastRow({
  notice,
  update,
  installed,
  status
}: {
  notice: PluginUpdateReviewNotice
  update: LoadedUpdate | undefined
  installed: PluginHostListEntry | undefined
  status?: string
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
      {status ? <p className="text-xs text-muted-foreground">{status}</p> : null}
    </div>
  )
}
