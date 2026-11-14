import { useState } from 'react'
import { Bookmark, Check, GitPullRequest } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { CommunityPullRequest } from '../../../../shared/community-catalog'
import type { CommunityFeature } from '../../../../shared/community-features'
import { CommunityChangeCard } from './CommunityChangeCard'

const EMPTY_INCLUDED_TITLES: readonly string[] = []
export function CommunityProposalCard({
  pr,
  feature,
  includedTitles = EMPTY_INCLUDED_TITLES,
  includedImageUrls,
  onOpen,
  onSave
}: {
  pr: CommunityPullRequest
  feature?: CommunityFeature
  includedImageUrls?: readonly string[]
  includedTitles?: readonly string[]
  onOpen: () => void
  onSave: () => Promise<unknown>
}): React.JSX.Element {
  const t = useTranslate()
  const [saving, setSaving] = useState(false)
  const cover = includedImageUrls?.find((src) => pr.imageUrls.includes(src))
  const previews = cover ? [cover, ...pr.imageUrls.filter((src) => src !== cover)] : pr.imageUrls
  return (
    <CommunityChangeCard
      number={pr.number}
      title={pr.displayTitle}
      label={`${pr.title} #${pr.number}`}
      category={`${pr.area} · ${pr.kind}`}
      metadata={`#${pr.number} · @${pr.author}`}
      description={
        includedTitles.length > 0
          ? `${t('community.buildIncludes', 'Build includes')}: ${includedTitles.join(' · ')}`
          : undefined
      }
      imageUrls={previews}
      imageAlt={t('community.authorImage', 'Image linked by the PR author')}
      emptyPreview={
        <>
          <GitPullRequest className="size-8" />
          <span className="text-xs">{t('community.codeProposal', 'Code proposal')}</span>
        </>
      }
      badge={
        includedTitles.length > 0 ? (
          <>
            <Check className="size-3" />
            {t('community.includedInRunningBuild', 'Included in this build')}
          </>
        ) : (
          feature?.visit &&
          (feature.visit.headSha === pr.headSha
            ? t('community.viewed', 'Viewed')
            : t('community.updated', 'Updated since visit'))
        )
      }
      onOpen={onOpen}
      footer={
        pr.state === 'merged'
          ? t('community.mergedSource', 'Merged into source')
          : pr.state === 'closed'
            ? t('community.closed', 'Closed')
            : pr.isDraft
              ? t('community.draft', 'Draft · Not merged')
              : t('community.unmerged', 'Not merged into official Orca')
      }
      action={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={
            feature?.savedAt
              ? t('community.unsave', 'Unsave proposal')
              : t('community.save', 'Save proposal')
          }
          aria-pressed={!!feature?.savedAt}
          disabled={saving}
          onClick={() => {
            setSaving(true)
            void onSave().finally(() => setSaving(false))
          }}
        >
          <Bookmark className={`size-4 ${feature?.savedAt ? 'fill-current' : ''}`} />
        </Button>
      }
    />
  )
}
