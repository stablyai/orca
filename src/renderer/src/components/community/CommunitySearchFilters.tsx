import { ImageIcon, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { CommunityPage, CommunityQuery } from '../../../../shared/community-operations'

export function CommunitySearchFilters({
  page,
  query,
  onQuery,
  onChooseAccount
}: {
  page: CommunityPage
  query: CommunityQuery
  onQuery: (query: CommunityQuery) => void
  onChooseAccount: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const supported = page.filterVersion === 1
  return (
    <>
      <form
        className="flex flex-wrap items-center gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          const data = new FormData(event.currentTarget)
          onQuery({ ...query, query: String(data.get('search') ?? '') })
        }}
      >
        <div className="relative min-w-48 flex-1">
          <Input
            name="search"
            key={query.query}
            defaultValue={query.query}
            placeholder={t('community.searchChanges', 'Search features, #PR, or PR URL')}
            aria-label={t('community.searchLabel', 'Search proposals')}
          />
        </div>
        <Button type="submit" variant="outline">
          {t('community.searchAction', 'Search')}
        </Button>
        <Button
          variant={query.mine ? 'secondary' : 'outline'}
          aria-pressed={!!query.mine}
          disabled={page.viewer === undefined}
          onClick={() => {
            if (query.mine || page.viewer) {
              onQuery({ ...query, mine: !query.mine })
            } else {
              onChooseAccount()
            }
          }}
        >
          <UserRound className="size-4" />
          {t('community.myPRs', 'My PRs')}
          {page.viewer && <Badge variant="secondary">{page.mineCount ?? 0}</Badge>}
        </Button>
        <Button
          variant={query.images ? 'secondary' : 'outline'}
          aria-pressed={!!query.images}
          onClick={() => onQuery({ ...query, images: !query.images })}
        >
          <ImageIcon className="size-4" />
          {t('community.images', 'Show PRs with images')}
          <span className="text-muted-foreground">
            · {page.summary.images.toLocaleString(locale)}
          </span>
        </Button>
        <Select
          value={query.sort ?? 'updated'}
          onValueChange={(sort) => {
            if (sort === 'updated' || sort === 'popular' || sort === 'oldest') {
              onQuery({ ...query, sort })
            }
          }}
        >
          <SelectTrigger
            aria-label={t('community.sort', 'Sort proposals')}
            className="w-40 max-sm:w-28"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="updated">
              {t('community.updatedSort', 'Recently updated')}
            </SelectItem>
            <SelectItem value="popular">{t('community.popularSort', 'Most reactions')}</SelectItem>
            <SelectItem value="oldest">{t('community.oldestSort', 'Oldest first')}</SelectItem>
          </SelectContent>
        </Select>
      </form>
      {(query.mine || page.viewer === undefined) && (
        <p role="status" className="text-xs text-muted-foreground">
          {page.viewer === undefined
            ? t('community.myPRsRuntime', 'Update this Orca host to use My PRs.')
            : page.viewer
              ? `${t('community.authoredBy', 'Authored by')} @${page.viewer} · ${t('community.repository', 'stablyai/orca')}`
              : t(
                  'community.myPRsAccount',
                  'Choose a GitHub account on this host to show your PRs.'
                )}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Select
          disabled={!supported}
          value={query.inclusion ?? 'all'}
          onValueChange={(inclusion) => {
            if (inclusion === 'all' || inclusion === 'installed' || inclusion === 'selected') {
              onQuery({ ...query, inclusion: inclusion === 'all' ? undefined : inclusion })
            }
          }}
        >
          <SelectTrigger
            className="w-48 max-sm:flex-1"
            aria-label={t('community.buildFilter', 'Build filter')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('community.allChanges', 'All changes')}</SelectItem>
            <SelectItem value="installed">
              {t('community.installedFilter', 'Installed in this build')}
            </SelectItem>
            <SelectItem value="selected">
              {t('community.selectedFilter', 'Selected for Custom')}
            </SelectItem>
          </SelectContent>
        </Select>
        <Select
          disabled={!supported}
          value={query.readiness ?? 'all'}
          onValueChange={(readiness) => {
            if (readiness === 'all' || readiness === 'ready' || readiness === 'draft') {
              onQuery({ ...query, readiness: readiness === 'all' ? undefined : readiness })
            }
          }}
        >
          <SelectTrigger
            className="w-44 max-sm:flex-1"
            aria-label={t('community.reviewFilter', 'Review status')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              {t('community.allReviewStates', 'All review states')}
            </SelectItem>
            <SelectItem value="ready">{t('community.readyFilter', 'Ready for review')}</SelectItem>
            <SelectItem value="draft">{t('community.draftFilter', 'Draft')}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={query.kind ?? 'all'}
          onValueChange={(kind) => onQuery({ ...query, kind: kind === 'all' ? undefined : kind })}
        >
          <SelectTrigger
            className="w-40 max-sm:flex-1"
            aria-label={t('community.kindFilter', 'Change type')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('community.allTypes', 'All change types')}</SelectItem>
            {page.summary.kinds.map((kind) => (
              <SelectItem value={kind.name} key={kind.name}>
                {kind.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={query.area ?? 'all'}
          onValueChange={(area) => onQuery({ ...query, area: area === 'all' ? undefined : area })}
        >
          <SelectTrigger
            className="w-44 max-sm:flex-1"
            aria-label={t('community.areaFilter', 'Feature area')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('community.allAreas', 'All areas')}</SelectItem>
            {page.summary.areas.map((area) => (
              <SelectItem value={area.name} key={area.name}>
                {area.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          'community.searchHelp',
          'Search titles, descriptions, authors, or a PR ID such as #41731.'
        )}
      </p>
      {!supported && (
        <p role="status" className="text-xs text-muted-foreground">
          {t('community.filtersRuntime', 'Update this Orca host to use build and review filters.')}
        </p>
      )}
    </>
  )
}
