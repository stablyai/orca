import { ArrowUpRight } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../../ui/button'
import type { PluginListEntry } from '../list/plugin-list-entries'
import { pluginCategoryLabel } from '../list/plugin-category-label'
import { DetailSection } from './PluginDetailSections'
import { formatPluginReleaseDate } from '../presentation/plugin-release-date'
import { usePluginRollbackVersion } from '../state/use-plugin-rollback-version'

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3 py-1 text-xs">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd
        data-mono={mono}
        className="min-w-0 truncate text-right data-[mono=true]:font-mono"
        title={value}
      >
        {value}
      </dd>
    </div>
  )
}

function LinkButton({ url, label }: { url: string | null; label: string }) {
  // Why: catalog and manifest links are untrusted; only open web links.
  if (!url?.startsWith('https://')) {
    return null
  }
  return (
    <Button
      variant="link"
      size="xs"
      className="-ml-2"
      onClick={() => void window.api.shell.openUrl(url)}
    >
      {label}
      <ArrowUpRight />
    </Button>
  )
}

/** The facts column of a plugin page: versions, requirements, identity and links. */
export function PluginDetailInfo({
  entry,
  version
}: {
  entry: PluginListEntry
  version: string | null
}): React.JSX.Element {
  const plugin = entry.installed
  const listing = entry.listing
  const rollbackVersion = usePluginRollbackVersion(
    plugin?.source?.kind === 'marketplace' ? plugin.pluginKey : null
  )
  // Why: "official" is trust, already shown by the verified mark.
  const categories = entry.categories.filter((category) => category !== 'official')
  const updated = formatPluginReleaseDate(listing?.updatedAt)
  const license = plugin?.license ?? listing?.license
  const repository =
    plugin?.repository ??
    listing?.repository ??
    listing?.source.url ??
    (plugin?.source?.kind === 'git' ? plugin.source.reference : null)
  const homepage = plugin?.homepage ?? listing?.homepage ?? null

  return (
    <aside className="mt-6">
      <h3 className="mb-2 text-2xs font-semibold tracking-[0.05em] text-muted-foreground uppercase">
        {translate('auto.components.settings.PluginDetailPage.info', 'Info')}
      </h3>
      <dl>
        {version ? (
          <InfoRow
            label={translate('auto.components.settings.PluginDetailPage.version', 'Version')}
            value={version}
          />
        ) : null}
        {entry.updateVersion ? (
          <InfoRow
            label={translate('auto.components.settings.PluginDetailPage.latest', 'Latest')}
            value={entry.updateVersion}
          />
        ) : null}
        {rollbackVersion ? (
          <InfoRow
            label={translate('auto.components.settings.PluginDetailInfo.previous', 'Previous')}
            value={rollbackVersion}
          />
        ) : null}
        {updated ? (
          <InfoRow
            label={translate('auto.components.settings.PluginDetailInfo.updated', 'Updated')}
            value={updated}
          />
        ) : null}
        {entry.minimumOrca ? (
          <InfoRow
            label={translate('auto.components.settings.PluginDetailPage.requires', 'Requires')}
            value={translate(
              'auto.components.settings.PluginDetailPage.requiresValue',
              'Orca {{value0}} or later',
              { value0: entry.minimumOrca }
            )}
          />
        ) : null}
        {license ? (
          <InfoRow
            label={translate('auto.components.settings.PluginDetailInfo.license', 'License')}
            value={license}
          />
        ) : null}
        {categories.length > 0 ? (
          <InfoRow
            label={translate('auto.components.settings.PluginDetailPage.categories', 'Categories')}
            value={[...new Set(categories.map(pluginCategoryLabel))].join(', ')}
          />
        ) : null}
        <InfoRow
          label={translate('auto.components.settings.PluginDetailPage.pluginId', 'Plugin ID')}
          value={entry.pluginKey}
          mono
        />
      </dl>
      <div className="mt-2 flex flex-col items-start">
        <LinkButton
          url={repository}
          label={translate('auto.components.settings.PluginDetailPage.repository', 'Repository')}
        />
        <LinkButton
          url={homepage}
          label={translate('auto.components.settings.PluginDetailInfo.homepage', 'Homepage')}
        />
      </div>
    </aside>
  )
}

/** The catalog's notes for its current release, shown as plain text. */
export function PluginReleaseNotes({
  entry
}: {
  entry: PluginListEntry
}): React.JSX.Element | null {
  const changelog = entry.listing?.changelog?.trim()
  if (!changelog) {
    return null
  }
  const version = entry.updateVersion ?? entry.version
  return (
    <DetailSection
      title={translate('auto.components.settings.PluginDetailInfo.whatsNew', 'What’s new')}
      count={version ? `v${version}` : undefined}
    >
      <p className="px-4 py-3 text-sm leading-6 whitespace-pre-line break-words">{changelog}</p>
    </DetailSection>
  )
}
