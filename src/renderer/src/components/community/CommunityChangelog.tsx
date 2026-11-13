import { useCallback, useState } from 'react'
import { ExternalLink, Package } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { getCustomBuildInfo } from '../../../../shared/custom-build'
import { communityClient } from './community-client'
import { useCommunityResource } from './use-community-resource'
import { CommunityReleaseHighlights } from './CommunityReleaseHighlights'
import { useCommunityNavigation } from './community-navigation'

export function CommunityChangelog({ target }: { target: RuntimeClientTarget }): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const resource = useCommunityResource(
    useCallback(() => communityClient(target).releases(), [target])
  )
  const releases =
    resource.value?.filter((release) =>
      `${release.tag} ${release.name} ${release.body}`.toLowerCase().includes(search.toLowerCase())
    ) ?? []
  const release = releases.find((entry) => entry.tag === selected) ?? releases[0]
  const baseVersion = getCustomBuildInfo()?.baseVersion
  const date = (value: string): string =>
    new Date(value).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })
  const open = (number: number): void => {
    useCommunityNavigation.getState().setSection('proposals')
    useCommunityNavigation.getState().open(number)
  }
  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-2xl font-semibold">
          {t('community.changelogTitle', 'What’s new in official Orca.')}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t(
            'community.visualChangelogNote',
            'Published releases, grouped by what changes for you. Open a version to see its source notes.'
          )}
        </p>
      </header>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Input
          className="max-w-3xl"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label={t('community.searchReleases', 'Search releases')}
          placeholder={t('community.searchReleasesPlaceholder', 'Find a version or change')}
        />
        <p className="text-xs text-muted-foreground">
          {t('community.yourTimeZone', 'Your time zone')} ·{' '}
          {Intl.DateTimeFormat(locale).resolvedOptions().timeZone}
        </p>
      </div>
      {resource.error && (
        <div role="alert" className="space-y-3 rounded-xl border border-border p-4">
          <p className="text-sm">{resource.error}</p>
          <Button variant="outline" onClick={resource.retry}>
            {t('community.retry', 'Retry')}
          </Button>
        </div>
      )}
      {!resource.value && !resource.error && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('community.loadingReleases', 'Loading published releases…')}
        </p>
      )}
      {resource.value && !releases.length && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('community.noMatchingReleases', 'No published releases match this search.')}
        </p>
      )}
      {release && (
        <div className="grid items-start gap-6 md:grid-cols-[10rem_minmax(0,1fr)]">
          <nav aria-label={t('community.releaseVersions', 'Published versions')}>
            <h3 className="mb-4 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('community.releaseVersions', 'Published versions')}
            </h3>
            <div className="max-h-[70dvh] space-y-2 overflow-y-auto scrollbar-sleek max-md:hidden">
              {releases.map((entry) => (
                <button
                  type="button"
                  key={entry.tag}
                  onClick={() => setSelected(entry.tag)}
                  aria-current={entry.tag === release.tag ? 'true' : undefined}
                  className="block w-full rounded-md p-3 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-current:bg-accent"
                >
                  <span className="block text-sm font-semibold">{entry.tag}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {date(entry.publishedAt)}
                  </span>
                </button>
              ))}
            </div>
            <div className="md:hidden">
              <Select value={release.tag} onValueChange={setSelected}>
                <SelectTrigger aria-label={t('community.releaseVersions', 'Published versions')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {releases.map((entry) => (
                    <SelectItem value={entry.tag} key={entry.tag}>
                      {entry.tag} · {date(entry.publishedAt)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="mt-5 text-xs text-muted-foreground">
              {releases.length} {t('community.versionsInCapture', 'versions in this capture')}
            </p>
          </nav>
          <article
            className="min-w-0 space-y-6 rounded-xl border border-border p-6 max-sm:p-4"
            key={release.tag}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">
                  <Package className="size-3" />
                  {release.prerelease
                    ? t('community.prerelease', 'Prerelease')
                    : t('community.officialRelease', 'Official release')}
                </Badge>
                {release.tag.replace(/^v/, '') === baseVersion && (
                  <Badge variant="secondary">
                    {t('community.customBaseRelease', 'Official base of this Custom build')}
                  </Badge>
                )}
              </div>
              <Button variant="link" size="sm" asChild>
                <a href={release.url} target="_blank" rel="noopener noreferrer">
                  {t('community.releaseNotes', 'Release notes')}
                  <ExternalLink className="size-4" />
                </a>
              </Button>
            </div>
            <header>
              <h3 className="text-3xl font-semibold max-sm:text-2xl">{release.name}</h3>
              <p className="mt-2 text-xs text-muted-foreground">
                {t('community.published', 'Published')}{' '}
                {new Date(release.publishedAt).toLocaleString(locale)}
              </p>
            </header>
            <CommunityReleaseHighlights body={release.body} onOpen={open} />
            <details className="border-t border-border pt-5">
              <summary className="cursor-pointer text-sm font-medium">
                {t('community.fullReleaseNotes', 'Read the complete official release notes')}
              </summary>
              <CommentMarkdown
                className="mt-5 break-words text-sm"
                content={
                  release.body || t('community.noReleaseNotes', 'No release notes were published.')
                }
                githubRepo={{ owner: 'stablyai', repo: 'orca' }}
              />
            </details>
          </article>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border p-5">
        <div>
          <h3 className="text-sm font-medium">
            {t('community.curiousNext', 'Curious about what comes next?')}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('community.nextAreProposals', 'Explore open PRs. They are still proposals.')}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => useCommunityNavigation.getState().setSection('proposals')}
        >
          {t('community.exploreProposals', 'Explore proposals')}
        </Button>
      </div>
    </div>
  )
}
