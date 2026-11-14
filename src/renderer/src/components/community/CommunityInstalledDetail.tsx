import { ArrowLeft, ArrowRight, Check, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useTranslate } from '@/i18n/use-translate'
import type { CustomBuildInfo } from '../../../../shared/custom-build'
import type { CommunityInstalledChange } from '../../../../shared/community-installed-changes'
import { CommunityImages } from './CommunityImages'

export function CommunityInstalledDetail({
  entry,
  build,
  onBack,
  onOpen
}: {
  entry: CommunityInstalledChange
  build: CustomBuildInfo
  onBack: () => void
  onOpen: (number: number) => void
}): React.JSX.Element {
  const t = useTranslate()
  const { change, proposal, imageUrls, previewSource } = entry
  const sourceUrl = build.source
    ? `https://github.com/${build.source.repository}/tree/${build.source.commit}`
    : null
  return (
    <div className="space-y-5">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="size-4" />
        {t('community.backInstalled', 'Back to installed features')}
      </Button>
      <header className="space-y-3">
        <Badge variant="secondary">
          <Check className="size-3" />
          {t('community.installed', 'Installed')}
        </Badge>
        <h3 className="text-xl font-semibold">{change.title}</h3>
        {change.description && <p className="text-sm leading-relaxed">{change.description}</p>}
        <div className="flex flex-wrap gap-2">
          {change.pullRequest && (
            <Button variant="outline" onClick={() => onOpen(change.pullRequest!.number)}>
              {t('community.inspectInstalledPr', 'Inspect PR and discuss with AI')}
              <ArrowRight className="size-4" />
            </Button>
          )}
          {sourceUrl && (
            <Button variant="outline" asChild>
              <a href={sourceUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-4" />
                {t('community.installedBuildSource', 'Inspect build source')}
              </a>
            </Button>
          )}
        </div>
      </header>
      <CommunityImages
        key={change.id}
        images={[...imageUrls]}
        title={change.title}
        emptyNote={t(
          'community.noInstalledPreview',
          'No screenshot is attached to this installed change.'
        )}
        sourceNote={
          previewSource === 'manifest'
            ? t(
                'community.manifestPreviewNote',
                'Previews supplied with this Custom build. Screenshots do not prove that checks passed.'
              )
            : t(
                'community.installedPrPreviewNote',
                'Previews from the captured PR description. They may show a different source version than your installed build.'
              )
        }
      />
      <section className="space-y-3 rounded-xl border border-border p-5">
        <h4 className="text-sm font-semibold">
          {t('community.installedVersion', 'Installed version')}
        </h4>
        <dl className="space-y-3 text-xs">
          <div>
            <dt className="text-muted-foreground">{t('community.buildIdentifier', 'Build')}</dt>
            <dd className="mt-1 break-all font-mono">{build.id}</dd>
          </div>
          {change.pullRequest && (
            <div>
              <dt className="text-muted-foreground">
                {t('community.installedPrCommit', 'Installed PR commit')}
              </dt>
              <dd className="mt-1 break-all font-mono">
                #{change.pullRequest.number} · {change.pullRequest.headSha}
              </dd>
            </div>
          )}
          {build.source && (
            <div>
              <dt className="text-muted-foreground">
                {t('community.buildCommit', 'Build source commit')}
              </dt>
              <dd className="mt-1 break-all font-mono">
                {build.source.repository} · {build.source.commit}
              </dd>
            </div>
          )}
        </dl>
        {!change.pullRequest && (
          <p className="text-xs text-muted-foreground">
            {t(
              'community.localChangeNote',
              'This local change has no linked PR. Review it in the build source.'
            )}
          </p>
        )}
        {proposal && change.pullRequest?.headSha !== proposal.headSha && (
          <p role="status" className="text-xs text-muted-foreground">
            {t(
              'community.installedOlderHead',
              'The PR has changed since this build. PR inspection opens the current source; the installed commit is shown above.'
            )}
          </p>
        )}
      </section>
    </div>
  )
}
