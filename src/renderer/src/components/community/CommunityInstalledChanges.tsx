import { ArrowRight, Check, ImageIcon, Package } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import {
  communityInstalledChanges,
  type CommunityInstalledSnapshot
} from '../../../../shared/community-installed-changes'
import { CommunityChangeCard } from './CommunityChangeCard'
import { CommunityInstalledDetail } from './CommunityInstalledDetail'
import { useCommunityNavigation } from './community-navigation'

export function CommunityInstalledChanges({
  snapshot,
  onOpen
}: {
  snapshot: CommunityInstalledSnapshot
  onOpen: (number: number) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const query = useCommunityNavigation((state) => state.installedQuery)
  const imagesOnly = useCommunityNavigation((state) => state.installedImagesOnly)
  const selectedId = useCommunityNavigation((state) => state.installedChangeId)
  const setQuery = useCommunityNavigation((state) => state.setInstalledQuery)
  const setImagesOnly = useCommunityNavigation((state) => state.setInstalledImagesOnly)
  const open = useCommunityNavigation((state) => state.openInstalled)
  const entries = communityInstalledChanges(snapshot, query, imagesOnly).sort(
    (a, b) =>
      Number(!!b.change.pullRequest) - Number(!!a.change.pullRequest) ||
      Number(b.imageUrls.length > 0) - Number(a.imageUrls.length > 0)
  )
  const selected = communityInstalledChanges(snapshot).find(
    (entry) => entry.change.id === selectedId
  )
  if (!snapshot.build) {
    return null
  }
  if (selected) {
    return (
      <CommunityInstalledDetail
        entry={selected}
        build={snapshot.build}
        onBack={() => open(null)}
        onOpen={onOpen}
      />
    )
  }
  return (
    <section
      className="space-y-4"
      aria-label={t('community.installedFeatures', 'Installed features')}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">
            {t('community.installedFeatures', 'Installed features')}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(
              'community.installedBrowseNote',
              'Search what is in this build. Open a card for previews, source details, and linked PR evidence.'
            )}
          </p>
        </div>
        <p role="status" className="text-xs text-muted-foreground">
          {entries.length} / {snapshot.build.changes.length}
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="min-w-48 flex-1">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t(
              'community.searchInstalledPlaceholder',
              'Search installed features or #PR'
            )}
            aria-label={t('community.searchInstalled', 'Search installed features')}
          />
        </div>
        <Button
          variant={imagesOnly ? 'secondary' : 'outline'}
          aria-pressed={imagesOnly}
          onClick={() => setImagesOnly(!imagesOnly)}
        >
          <ImageIcon className="size-4" />
          {t('community.withImages', 'With images')}
        </Button>
        {(query || imagesOnly) && (
          <Button
            variant="ghost"
            onClick={() => {
              setQuery('')
              setImagesOnly(false)
            }}
          >
            {t('community.clearFilters', 'Clear filters')}
          </Button>
        )}
      </div>
      <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {entries.map(({ change, imageUrls, previewSource }) => (
          <CommunityChangeCard
            key={change.id}
            changeId={change.id}
            title={change.title}
            label={change.title}
            category={
              change.pullRequest
                ? `#${change.pullRequest.number}`
                : t('community.localChange', 'Local change')
            }
            metadata={
              imageUrls.length > 0
                ? previewSource === 'manifest'
                  ? t('community.buildPreviews', 'Build author previews')
                  : t('community.prPreviews', 'PR author previews')
                : t('community.sourceAvailable', 'Open to inspect the source')
            }
            imageUrls={imageUrls}
            imageAlt={change.title}
            emptyPreview={
              <>
                <Package className="size-8" />
                <span className="text-xs">
                  {t('community.noPreviewAttached', 'No preview attached')}
                </span>
              </>
            }
            badge={
              <>
                <Check className="size-3" />
                {t('community.installed', 'Installed')}
              </>
            }
            onOpen={() => open(change.id)}
            footer={
              <Button variant="link" size="inline" onClick={() => open(change.id)}>
                {t('community.viewInstalledDetails', 'View feature details')}
                <ArrowRight className="size-4" />
              </Button>
            }
          />
        ))}
      </div>
      {!entries.length && (
        <p className="py-6 text-sm text-muted-foreground">
          {t('community.noInstalledMatches', 'No installed features match these filters.')}
        </p>
      )}
    </section>
  )
}
