import { useCallback, useState } from 'react'
import { ExternalLink, Package } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { communityClient } from './community-client'
import { useCommunityResource } from './use-community-resource'
export function CommunityChangelog({ target }: { target: RuntimeClientTarget }): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const [search, setSearch] = useState('')
  const resource = useCommunityResource(
    useCallback(() => communityClient(target).releases(), [target])
  )
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t('community.changelogTitle', 'What shipped in official Orca')}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t(
            'community.changelogNote',
            'Published GitHub releases. Open proposals and your Custom additions stay separate.'
          )}
        </p>
      </div>
      <Input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        aria-label={t('community.searchReleases', 'Search releases')}
        placeholder={t('community.searchReleasesPlaceholder', 'Find a version or change')}
      />
      <div className="space-y-5">
        {resource.value
          ?.filter((release) =>
            `${release.tag} ${release.body}`.toLowerCase().includes(search.toLowerCase())
          )
          .map((release) => (
            <article className="rounded-xl border border-border p-6" key={release.tag}>
              <header className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="flex items-center gap-2 text-lg font-semibold">
                    <Package className="size-5" />
                    {release.name}
                    <Badge variant="secondary">
                      {release.prerelease
                        ? t('community.prerelease', 'Prerelease')
                        : t('community.published', 'Published')}
                    </Badge>
                  </h3>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {new Date(release.publishedAt).toLocaleString(locale)}
                  </p>
                </div>
                <Button variant="outline" size="sm" asChild>
                  <a href={release.url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="size-4" />
                    {t('community.releaseNotes', 'Release notes')}
                  </a>
                </Button>
              </header>
              <p className="mt-5 max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm leading-relaxed scrollbar-sleek">
                {release.body || t('community.noReleaseNotes', 'No release notes were published.')}
              </p>
            </article>
          ))}
      </div>
      {!resource.value && (
        <p role="status" className="text-sm text-muted-foreground">
          {resource.error ?? t('community.loadingReleases', 'Loading published releases…')}
        </p>
      )}
      {resource.error && (
        <Button variant="outline" onClick={resource.retry}>
          {t('community.retry', 'Retry')}
        </Button>
      )}
    </div>
  )
}
