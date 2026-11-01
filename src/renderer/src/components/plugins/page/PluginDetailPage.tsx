import { useEffect, useRef } from 'react'
import { BadgeCheck, ChevronLeft } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { pluginOfficialLabel } from '../presentation/plugin-official-label'
import { Button } from '../../ui/button'
import { needsNewerOrca, type PluginListEntry } from '../list/plugin-list-entries'
import { PluginDetailAlert as Alert } from './PluginDetailAlert'
import { usePluginPageAction } from './PluginPageAction'
import { PluginPageHero, PluginScreenshots } from './PluginPageHero'
import { usePluginArtPalettes } from '../state/use-plugin-art-palettes'
import { usePluginPageModel } from '../state/use-plugin-page-model'
import type { usePluginInstallAction } from '../state/use-plugin-install-action'
import { PluginDetailInfo, PluginReleaseNotes } from './PluginDetailInfo'
import { PluginAddsSection } from './PluginAddsSection'
import { PluginAccessSection, PluginLogsSection } from './PluginDetailSections'
import { installedPluginControls, type InstalledRowHandlers } from '../list/PluginManagerRows'
import { PluginChips } from '../list/PluginChips'
import type { PluginPagePreview } from '../state/use-plugin-catalog'
import type { PluginLogsState } from '../state/use-plugin-logs'
import { pluginPublisherNotice } from '../presentation/plugin-publisher-trust'
import { PluginNotOfficialWarning } from '../review/PluginNotOfficialWarning'

type PluginDetailPageProps = {
  entry: PluginListEntry
  busy: boolean
  orcaVersion: string | null
  logsState: PluginLogsState | undefined
  handlers: InstalledRowHandlers
  fetchPreview: (listing: NonNullable<PluginListEntry['listing']>) => Promise<PluginPagePreview>
  install: ReturnType<typeof usePluginInstallAction>
  /** A catalog refresh is in flight. */
  refreshing: boolean
  onConsent: (
    pluginKey: string,
    reviewedFingerprint: string,
    decision: 'approve' | 'keep-disabled'
  ) => Promise<void>
  onBack: () => void
  onOpenShortcuts: () => void
}

function sourceLabel(entry: PluginListEntry): string {
  const source = entry.installed?.source
  if (entry.installed?.bundled || source?.kind === 'bundled') {
    return translate('auto.components.settings.PluginDetailPage.bundled', 'Bundled with Orca')
  }
  if (source?.kind === 'local-path') {
    return translate('auto.components.settings.PluginDetailPage.localFolder', 'Local folder')
  }
  if (source?.kind === 'git') {
    return translate('auto.components.settings.PluginDetailPage.gitUrl', 'Git URL')
  }
  return entry.listing?.marketplaceName ?? ''
}

/** One plugin's page: what it adds, what it can reach, where it came from, and its logs. */
export function PluginDetailPage({
  entry,
  busy,
  orcaVersion,
  logsState,
  handlers,
  fetchPreview,
  install,
  refreshing,
  onConsent,
  onBack,
  onOpenShortcuts
}: PluginDetailPageProps): React.JSX.Element {
  const model = usePluginPageModel({ entry, fetchPreview, refreshing })
  const { plugin, listing, preview, stale } = model
  const palettes = usePluginArtPalettes(entry.pluginKey, listing?.release?.themePreview)
  const tooNew = needsNewerOrca(entry.minimumOrca, orcaVersion) !== null
  // Why: a fetched manifest names the plugin exactly; older catalogs only give its key.
  const name = plugin?.name ?? preview?.manifest.name ?? entry.name
  const action = usePluginPageAction({
    entry,
    name,
    model,
    unavailable: Boolean(listing?.blockedByKillList) || tooNew,
    busy,
    install,
    onConsent
  })
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [entry.pluginKey])

  const controls = plugin
    ? installedPluginControls(plugin, entry, {
        busy,
        canCheckUpdate: entry.updatable,
        handlers,
        inPage: true
      })
    : null
  const version = plugin?.version ?? preview?.manifest.version ?? entry.version
  const description = plugin?.description ?? preview?.manifest.description ?? entry.description

  const publisherNotice = pluginPublisherNotice({
    official: entry.official,
    execution: model.execution,
    manifest: model.manifest,
    // Why null without a release or host types: an empty list would read as "no translations".
    types: plugin ? (plugin.types ?? null) : listing?.release ? entry.types : null
  })

  let alert: React.ReactNode = null
  if (plugin?.blockedByKillList) {
    alert = (
      <Alert
        tone="destructive"
        title={translate('auto.components.settings.PluginStatus.blocked', 'Blocked')}
        body={translate(
          'auto.components.settings.PluginSettingsRow.killListMessage',
          "Orca's safety list disabled this plugin: {{value0}}",
          { value0: plugin.blockedByKillList.reason }
        )}
      />
    )
  } else if (controls?.kind === 'error') {
    alert = (
      <Alert
        tone="destructive"
        title={translate(
          'auto.components.settings.PluginDetailPage.stoppedTitle',
          'Stopped after an error'
        )}
        body={
          // Why: a content-only plugin has no code to crash; its files failed to load.
          plugin?.execution === 'data'
            ? translate(
                'auto.components.settings.PluginDetailPage.stoppedDataBody',
                'Couldn’t load its files. Restart to try again.'
              )
            : translate(
                'auto.components.settings.PluginDetailPage.stoppedBody',
                'It kept crashing. Restart to try again.'
              )
        }
      />
    )
  } else if (controls?.kind === 'invalid') {
    alert = (
      <Alert
        tone="destructive"
        title={translate(
          'auto.components.settings.PluginDetailPage.invalidTitle',
          'Orca can’t load this plugin'
        )}
        body={typeof controls.description === 'string' ? controls.description : ''}
      />
    )
  } else if (!plugin && listing?.blockedByKillList) {
    alert = (
      <Alert
        tone="destructive"
        title={translate('auto.components.settings.PluginStatus.blocked', 'Blocked')}
        body={translate(
          'auto.components.settings.PluginMarketplaceListingRow.blocked',
          "Blocked by Orca's safety list: {{value0}}",
          { value0: listing.blockedByKillList.reason }
        )}
      />
    )
  } else if (stale) {
    alert = (
      <Alert
        tone="info"
        title={translate(
          'auto.components.settings.PluginDetailPage.newerTitle',
          'Newer version available'
        )}
        body={translate(
          'auto.components.settings.PluginDetailPage.newerBody',
          'The catalog changed while you were here.'
        )}
        action={
          <Button variant="outline" size="xs" onClick={model.showNewer}>
            {translate('auto.components.settings.PluginDetailPage.showNewer', 'Show newer')}
          </Button>
        }
      />
    )
  } else if (!plugin && tooNew) {
    alert = (
      <Alert
        tone="warning"
        title={translate(
          'auto.components.settings.PluginDetailPage.needsOrcaTitle',
          'Needs Orca {{value0}} or later',
          {
            value0: entry.minimumOrca ?? ''
          }
        )}
        body={translate(
          'auto.components.settings.PluginDetailPage.needsOrcaBody',
          'You have Orca {{value0}}.',
          {
            value0: orcaVersion ?? ''
          }
        )}
      />
    )
  }

  return (
    <article aria-labelledby="plugin-detail-heading" className="@container/plugin-detail">
      <Button variant="ghost" size="xs" className="-ml-2" onClick={onBack}>
        <ChevronLeft />
        {translate('auto.components.settings.PluginDetailPage.back', 'Plugins')}
      </Button>
      <div className="mt-4 flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3
              id="plugin-detail-heading"
              ref={headingRef}
              tabIndex={-1}
              className="text-xl font-semibold outline-none"
            >
              {name}
            </h3>
            {entry.official ? (
              <BadgeCheck
                className="plugin-security-chrome size-4 text-muted-foreground"
                role="img"
                aria-label={pluginOfficialLabel()}
              />
            ) : null}
            <PluginChips entry={entry} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {[entry.publisher, version ? `v${version}` : null, sourceLabel(entry)]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {entry.alsoListedBy.length > 0 ? (
            <p data-plugin-also-listed="" className="mt-1 text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.PluginDetailPage.alsoListedBy',
                'Also listed by {{value0}}. Updates come only from the catalog it was installed from; to switch, remove it and install it again.',
                { value0: entry.alsoListedBy.join(', ') }
              )}
            </p>
          ) : null}
          {/* Why always there: installing fills this line instead of pushing the page down. */}
          <div className="mt-2 flex h-5 items-center gap-3">
            {controls && controls.kind !== 'review' ? controls.status : null}
            {action.status}
          </div>
        </div>
        {/* Why one slot: Install, Install & enable, Enable and the installed switch all sit here,
            so a state change never moves the page. */}
        <div className="flex min-h-9 items-center gap-2">
          {action.header}
          {controls && controls.kind !== 'review' ? (
            <>
              {controls.action}
              {controls.toggle}
            </>
          ) : null}
          {controls ? controls.more : null}
        </div>
      </div>
      {publisherNotice !== 'none' ? (
        // Why above the consent: it is part of the install decision, read before the access list.
        <div className="mt-4">
          <PluginNotOfficialWarning
            notice={publisherNotice}
            publisher={entry.publisher}
            moment={plugin ? 'installed' : 'install'}
          />
        </div>
      ) : null}
      {action.body}
      {description ? <p className="mt-4 max-w-prose text-sm leading-6">{description}</p> : null}
      {alert}
      {/* Why after the decision: the picture must never push Install or Enable below the fold. */}
      <div className="mt-6">
        <PluginPageHero entry={entry} images={model.images} palettes={palettes} />
      </div>
      <div className="mt-2 grid grid-cols-[minmax(0,1fr)_14.5rem] gap-7 @max-2xl/plugin-detail:grid-cols-1 @max-2xl/plugin-detail:gap-0">
        <div className="min-w-0">
          <PluginScreenshots images={model.images} />
          <PluginAddsSection
            plugin={plugin}
            preview={preview}
            summary={listing?.release?.contributes}
            themePreview={listing?.release?.themePreview}
            types={entry.types}
            onOpenShortcuts={onOpenShortcuts}
          />
          {/* Why installed only: before install, and while it waits for review, the consent above says this. */}
          {plugin && controls?.kind !== 'review' ? (
            <PluginAccessSection capabilities={plugin.capabilities} trust={model.trust} />
          ) : null}
          <PluginReleaseNotes entry={entry} />
          {plugin?.hasWorker ? <PluginLogsSection state={logsState} /> : null}
        </div>
        <PluginDetailInfo entry={entry} version={version} />
      </div>
    </article>
  )
}
