import { ArrowUpRight } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../../ui/button'
import type { PluginListEntry } from '../list/plugin-list-entries'
import { PluginCategoryBadges } from '../list/PluginCategoryBadge'
import { pluginFilterKinds } from '../list/plugin-list-filter'
import { DetailSection } from './PluginDetailSections'
import { formatPluginReleaseDate } from '../presentation/plugin-release-date'
import {
  formatPluginInstallCount,
  usePluginInstallCount
} from '../presentation/plugin-install-count'
import { usePluginRollbackVersion } from '../state/use-plugin-rollback-version'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { pluginRepositoryPageUrl } from '../../../../../shared/plugins/catalog/plugin-repository-link'
import type { PluginAuthor } from '../presentation/plugin-author'
import {
  pluginAuthorGithubUrl,
  pluginSourceGitUrl,
  pluginSourceReadmeUrl
} from '../presentation/plugin-source-links'
import { PluginAuthorCard } from './PluginAuthor'

function InfoRow({
  label,
  value,
  mono = false
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="flex justify-between gap-3 py-1 text-xs">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd
        data-mono={mono}
        className="min-w-0 truncate text-right data-[mono=true]:font-mono"
        title={typeof value === 'string' ? value : undefined}
      >
        {value}
      </dd>
    </div>
  )
}

function ExternalLink({ url, label }: { url: string | null; label: string }) {
  if (!url) {
    return null
  }
  return (
    <Button
      variant="link"
      size="xs"
      className="-ml-1.5"
      onClick={(event) => openAppHttpLink(url, { event })}
    >
      {label}
      <ArrowUpRight />
    </Button>
  )
}

/** The facts column of a plugin page: its author, then versions, requirements, identity and links. */
export function PluginDetailInfo({
  entry,
  version,
  author,
  authorPluginCount
}: {
  entry: PluginListEntry
  version: string | null
  author: PluginAuthor | null
  authorPluginCount: number | null
}): React.JSX.Element {
  const plugin = entry.installed
  const listing = entry.listing
  const rollbackVersion = usePluginRollbackVersion(
    plugin?.source?.kind === 'marketplace' ? plugin.pluginKey : null
  )
  const installCount = usePluginInstallCount(entry)
  const updated = formatPluginReleaseDate(listing?.updatedAt)
  const license = plugin?.license ?? listing?.license
  const sourceUrl = pluginSourceGitUrl(entry)
  const repository = sourceUrl ? pluginRepositoryPageUrl(sourceUrl) : null
  const readme = pluginSourceReadmeUrl(entry)

  return (
    <aside className="@max-2xl/plugin-detail:mt-6">
      {author ? (
        <PluginAuthorCard
          author={author}
          pluginCount={authorPluginCount}
          profileUrl={pluginAuthorGithubUrl(entry)}
        />
      ) : null}
      <section className="mt-4 rounded-xl border border-border/50 bg-card/50 p-3.5 shadow-xs first:mt-0">
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
          {installCount !== null ? (
            <InfoRow
              label={translate('auto.components.settings.PluginDetailInfo.installs', 'Installs')}
              value={formatPluginInstallCount(installCount)}
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
          {pluginFilterKinds(entry).size > 0 ? (
            <InfoRow
              label={translate(
                'auto.components.settings.PluginDetailPage.categories',
                'Categories'
              )}
              value={<PluginCategoryBadges entry={entry} />}
            />
          ) : null}
          <InfoRow
            label={translate('auto.components.settings.PluginDetailPage.pluginId', 'Plugin ID')}
            value={entry.pluginKey}
            mono
          />
        </dl>
        {repository || readme ? (
          <div className="mt-2 flex flex-col items-start border-t border-border/50 pt-2">
            <ExternalLink
              url={repository}
              label={translate(
                'auto.components.settings.PluginDetailPage.repository',
                'Repository'
              )}
            />
            <ExternalLink
              url={readme}
              label={translate(
                'auto.components.settings.PluginDetailInfo.readme',
                'Read the README on {{value0}}',
                { value0: readme?.startsWith('https://gitlab.com/') ? 'GitLab' : 'GitHub' }
              )}
            />
          </div>
        ) : null}
      </section>
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
