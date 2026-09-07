import { BadgeCheck, Info } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/** Review dialogs lead with trust, not a metadata table: badge up front, details on demand. */

export type PluginConsentSource = {
  kind: 'local-path' | 'git' | 'marketplace' | 'bundled'
  reference: string
  resolvedCommit: string | null
  marketplace?: { reference: string; resolvedCommit: string }
}

type PluginConsentProvenanceProps = {
  official: boolean
  publisher: string
  source?: PluginConsentSource
}

function shortCommit(commit: string | null | undefined): string | null {
  return commit && commit.length > 10 ? commit.slice(0, 10) : (commit ?? null)
}

function ProvenanceDetail({
  label,
  value,
  fullValue
}: {
  label: string
  value: string
  fullValue?: string
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-x-2">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="break-all font-mono text-[11px] leading-5" title={fullValue}>
        {value}
      </span>
    </div>
  )
}

function provenanceBadge(props: PluginConsentProvenanceProps): React.JSX.Element {
  if (props.official) {
    return (
      <Badge variant="secondary" className="gap-1">
        <BadgeCheck className="size-3.5" />
        {translate('auto.components.settings.PluginConsentProvenance.official', 'Official')}
        {props.publisher ? ` · ${props.publisher}` : ''}
      </Badge>
    )
  }
  if (props.source?.kind === 'bundled') {
    return (
      <Badge variant="outline">
        {translate('auto.components.settings.PluginConsentProvenance.bundled', 'Bundled with Orca')}
      </Badge>
    )
  }
  if (props.source?.kind === 'local-path') {
    return (
      <Badge variant="outline">
        {translate('auto.components.settings.PluginConsentProvenance.local', 'Local folder')}
      </Badge>
    )
  }
  return (
    <Badge variant="outline">
      {translate('auto.components.settings.PluginConsentProvenance.community', 'Community')}
      {props.publisher ? ` · ${props.publisher}` : ''}
    </Badge>
  )
}

export function PluginConsentProvenance(props: PluginConsentProvenanceProps): React.JSX.Element {
  const { source } = props
  const pinned = shortCommit(source?.resolvedCommit)
  return (
    <div className="flex items-center gap-1.5">
      {provenanceBadge(props)}
      {source ? (
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="xs" className="text-muted-foreground">
              <Info />
              {translate('auto.components.settings.PluginConsentProvenance.source', 'Source')}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 space-y-1.5 p-3">
            <ProvenanceDetail
              label={translate(
                'auto.components.settings.PluginConsentProvenance.sourceLabel',
                'Source'
              )}
              value={source.reference}
              fullValue={source.reference}
            />
            <ProvenanceDetail
              label={translate(
                'auto.components.settings.PluginConsentProvenance.commit',
                'Pinned commit'
              )}
              value={
                pinned ??
                translate(
                  'auto.components.settings.PluginConsentProvenance.localCommit',
                  'Local folder — no commit'
                )
              }
              fullValue={source.resolvedCommit ?? undefined}
            />
            {source.marketplace ? (
              <ProvenanceDetail
                label={translate(
                  'auto.components.settings.PluginConsentProvenance.indexCommit',
                  'Index commit'
                )}
                value={shortCommit(source.marketplace.resolvedCommit) ?? ''}
                fullValue={source.marketplace.resolvedCommit}
              />
            ) : null}
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  )
}
