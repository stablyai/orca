import { useEffect, useRef, useState } from 'react'
import { BadgeCheck, ChevronLeft, CircleAlert, Info, TriangleAlert } from 'lucide-react'
import type { PluginMarketplaceHostInstallPreview } from '../../../../preload/api-types'
import { satisfiesOrcaEngineRange } from '../../../../shared/plugins/plugin-manifest'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { PluginCatalogAvatar } from '../plugin-catalog/PluginCatalogAvatar'
import type { PluginListEntry } from '../plugin-catalog/plugin-list-entries'
import { PluginDetailInfo, PluginReleaseNotes } from './PluginDetailInfo'
import { PluginAddsSection } from './PluginAddsSection'
import { PluginAccessSection, PluginLogsSection } from './PluginDetailSections'
import { installedPluginControls, type InstalledRowHandlers } from './PluginManagerRows'
import { PluginChips } from '../plugin-catalog/PluginChips'
import type { PluginPagePreview } from './use-plugin-catalog'
import type { PluginLogsState } from './use-plugin-logs'
import { pluginPageExecutionProfile } from './plugin-access-profile'
import { useInstalledPluginManifest } from './use-plugin-contribution-source'

type PluginDetailPageProps = {
  entry: PluginListEntry
  busy: boolean
  orcaVersion: string | null
  logsState: PluginLogsState | undefined
  handlers: InstalledRowHandlers
  fetchPreview: (listing: NonNullable<PluginListEntry['listing']>) => Promise<PluginPagePreview>
  onInstall: (entry: PluginListEntry) => void
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

function Alert({
  tone,
  title,
  body,
  action
}: {
  tone: 'info' | 'warning' | 'destructive'
  title: string
  body: string
  action?: React.ReactNode
}): React.JSX.Element {
  const Icon = tone === 'info' ? Info : tone === 'warning' ? TriangleAlert : CircleAlert
  return (
    <div
      role="status"
      data-tone={tone}
      className="mt-5 flex items-start gap-2.5 rounded-xl border border-border bg-muted/40 px-3.5 py-3 text-sm data-[tone=destructive]:border-destructive/35 data-[tone=destructive]:bg-destructive/7 data-[tone=warning]:border-status-warning/45 data-[tone=warning]:bg-status-warning/7"
    >
      <Icon
        aria-hidden="true"
        data-tone={tone}
        className="mt-0.5 size-4 shrink-0 data-[tone=destructive]:text-destructive data-[tone=warning]:text-status-warning"
      />
      <div className="min-w-0 flex-1">
        <p data-tone={tone} className="font-medium data-[tone=destructive]:text-destructive">
          {title}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{body}</p>
      </div>
      {action}
    </div>
  )
}

/** One plugin's page: what it adds, what it can reach, where it came from, and its logs. */
export function PluginDetailPage({
  entry,
  busy,
  orcaVersion,
  logsState,
  handlers,
  fetchPreview,
  onInstall,
  onBack,
  onOpenShortcuts
}: PluginDetailPageProps): React.JSX.Element {
  const plugin = entry.installed
  const listing = entry.listing
  const [preview, setPreview] = useState<PluginMarketplaceHostInstallPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(!plugin && Boolean(listing))
  const [previewFailed, setPreviewFailed] = useState(false)
  const [previewAttempt, setPreviewAttempt] = useState(0)
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [entry.pluginKey])

  useEffect(() => {
    if (plugin || !listing) {
      return
    }
    let stale = false
    setPreviewLoading(true)
    setPreviewFailed(false)
    void fetchPreview(listing).then((result) => {
      if (!stale) {
        setPreview(result.ok ? result.preview : null)
        setPreviewFailed(!result.ok)
        setPreviewLoading(false)
      }
    })
    return () => {
      stale = true
    }
  }, [plugin, listing, fetchPreview, previewAttempt])

  // Why the manifest read: hosts that predate the list's `execution` field still get a verified profile.
  const installedManifest = useInstalledPluginManifest(
    plugin && plugin.execution === undefined ? plugin.pluginKey : null
  )
  const execution = pluginPageExecutionProfile({
    installed: plugin,
    installedManifest,
    listing,
    previewManifest: preview?.manifest ?? null
  })
  const controls = plugin
    ? installedPluginControls(plugin, entry, {
        busy,
        canCheckUpdate: entry.updatable,
        handlers,
        inPage: true
      })
    : null
  const tooNew =
    Boolean(entry.minimumOrca && orcaVersion) &&
    !satisfiesOrcaEngineRange(orcaVersion ?? '', `>=${entry.minimumOrca}`)
  const version = plugin?.version ?? preview?.manifest.version ?? entry.version
  // Why: a fetched manifest names the plugin exactly; older catalogs only give its key.
  const name = plugin?.name ?? preview?.manifest.name ?? entry.name
  const description = plugin?.description ?? preview?.manifest.description ?? entry.description

  let alert: React.ReactNode = null
  if (plugin?.blockedByKillList) {
    alert = (
      <Alert
        tone="destructive"
        title={translate('auto.components.settings.PluginSettingsRow.blocked', 'Blocked')}
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
        body={translate(
          'auto.components.settings.PluginDetailPage.stoppedBody',
          'Its code kept crashing, so Orca stopped restarting it. It’s still switched on; Restart tries again.'
        )}
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
  } else if (controls?.kind === 'review') {
    alert = (
      <Alert
        tone="info"
        title={translate('auto.components.settings.PluginSettingsRow.needsReview', 'Needs review')}
        body={translate(
          'auto.components.settings.PluginDetailPage.reviewBody',
          'Review what it adds and what it can reach, then enable it. Nothing runs before that.'
        )}
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
          'You have Orca {{value0}}. Update Orca to install this plugin.',
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
      <div className="mt-4 grid grid-cols-[2.75rem_minmax(0,1fr)_auto] items-start gap-x-3.5 @max-xl/plugin-detail:grid-cols-[2.75rem_minmax(0,1fr)]">
        <PluginCatalogAvatar name={entry.name} className="size-11 rounded-xl text-xs" />
        <div className="min-w-0">
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
                aria-label={translate(
                  'auto.components.pluginCatalog.PluginListRow.official',
                  'Official'
                )}
              />
            ) : null}
            <PluginChips entry={entry} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {[entry.publisher, version ? `v${version}` : null, sourceLabel(entry)]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {controls ? <div className="mt-2">{controls.status}</div> : null}
        </div>
        <div className="flex items-center gap-2 @max-xl/plugin-detail:col-start-2 @max-xl/plugin-detail:mt-3">
          {controls ? (
            <>
              {controls.action}
              {controls.toggle}
              {controls.more}
            </>
          ) : (
            <Button
              size="sm"
              disabled={tooNew || Boolean(listing?.blockedByKillList)}
              onClick={() => onInstall(entry)}
            >
              {translate('auto.components.settings.PluginDetailPage.install', 'Install…')}
            </Button>
          )}
        </div>
      </div>
      {alert}
      <div className="mt-2 grid grid-cols-[minmax(0,1fr)_14.5rem] gap-7 @max-2xl/plugin-detail:grid-cols-1 @max-2xl/plugin-detail:gap-0">
        <div className="min-w-0">
          {description ? <p className="mt-5 max-w-prose text-sm leading-6">{description}</p> : null}
          <PluginAddsSection
            plugin={plugin}
            preview={preview}
            types={entry.types}
            onOpenShortcuts={onOpenShortcuts}
          />
          <PluginAccessSection
            capabilities={
              plugin?.capabilities ??
              preview?.manifest.capabilities.map((capability) => ({
                kind: capability.kind,
                description: capability.kind
              })) ??
              null
            }
            execution={execution}
            loading={
              previewLoading ||
              (plugin !== null && execution === null && installedManifest === undefined)
            }
            failed={!plugin && previewFailed}
            onRetry={() => setPreviewAttempt((attempt) => attempt + 1)}
          />
          <PluginReleaseNotes entry={entry} />
          {plugin?.hasWorker ? <PluginLogsSection state={logsState} /> : null}
        </div>
        <PluginDetailInfo entry={entry} version={version} />
      </div>
    </article>
  )
}
