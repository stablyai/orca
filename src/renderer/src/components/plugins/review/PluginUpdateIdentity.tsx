// @protected-copy
import { ExternalLink, TriangleAlert } from 'lucide-react'
import type { PluginMarketplaceHostInstallPreview } from '../../../../../preload/api/plugins/plugin-host-api'
import { pluginExecutionProfile } from '../../../../../shared/plugins/contributions/plugin-execution-profile'
import { splitQualifiedPluginKey } from '../../../../../shared/plugins/catalog/plugin-marketplace'
import { useTranslate } from '@/i18n/use-translate'
import { Badge } from '../../ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { pluginPublisherNotice } from '../presentation/plugin-publisher-trust'
import { PluginPublisherBadge } from './PluginConsentProvenance'
import { pluginNotOfficialBody } from './PluginNotOfficialWarning'

/** The publisher from the catalog key, never the manifest's own claim. */
export const pluginKeyOwner = (pluginKey: string): string =>
  splitQualifiedPluginKey(pluginKey)?.publisher ?? ''

/**
 * GitHub's history of the plugin's folder up to the commit being installed. Why the commit, not
 * the ref: a mirror tag has slashes GitHub would read as a path, and the commit is what was reviewed.
 */
export function pluginSourceHistoryUrl(
  source: { url: string; path?: string },
  commit: string
): string | null {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(source.url)
  if (!match || !/^[0-9a-f]{40}$/.test(commit)) {
    return null
  }
  const path = source.path ? `/${source.path.split('/').map(encodeURIComponent).join('/')}` : ''
  return `https://github.com/${match[1]}/commits/${commit}${path}`
}

/**
 * Who publishes an update and where its history is: "Official · stablyai", or an amber
 * "Community plugin · owner" whose trust advice shows on hover.
 */
export function PluginUpdatePublisher({
  pluginKey,
  preview
}: {
  pluginKey: string
  preview: PluginMarketplaceHostInstallPreview
}): React.JSX.Element {
  const t = useTranslate()
  const publisher = pluginKeyOwner(pluginKey)
  const notice = pluginPublisherNotice({
    official: preview.official,
    execution: pluginExecutionProfile(preview.manifest),
    manifest: preview.manifest,
    types: null
  })
  if (preview.official || preview.managedByTeams) {
    return (
      <PluginPublisherBadge
        official={preview.official}
        publisher={publisher}
        managedByTeams={preview.managedByTeams}
      />
    )
  }
  const label = `${t('auto.components.settings.PluginNotOfficialWarning.community', 'Community plugin')}${publisher ? ` · ${publisher}` : ''}`
  // Why plain: a community plugin that runs no code (a theme, say) has nothing to trust it with.
  if (notice === 'none') {
    return <Badge variant="outline">{label}</Badge>
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="warning" tabIndex={0} data-plugin-not-official={notice}>
          <TriangleAlert className="size-3.5" aria-hidden="true" />
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-72">
        {pluginNotOfficialBody(notice, publisher, 'update', t)}
      </TooltipContent>
    </Tooltip>
  )
}

/** "2.1.0 → 2.3.1", linked to the plugin's history on GitHub when the source is there. */
export function PluginUpdateVersions({
  from,
  preview
}: {
  from: string | undefined
  preview: PluginMarketplaceHostInstallPreview
}): React.JSX.Element {
  const t = useTranslate()
  const text = `${from ? `${from} → ` : ''}${preview.manifest.version}`
  const history = pluginSourceHistoryUrl(preview.source, preview.resolvedCommit)
  if (!history) {
    return <span className="ml-1.5 text-xs font-normal text-muted-foreground">{text}</span>
  }
  return (
    <a
      href={history}
      target="_blank"
      rel="noreferrer"
      title={t('auto.components.settings.PluginUpdateReview.history', 'See its changes on GitHub')}
      className="ml-1.5 inline-flex items-center gap-1 text-xs font-normal text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      {text}
      <ExternalLink className="size-3" aria-hidden="true" />
    </a>
  )
}
