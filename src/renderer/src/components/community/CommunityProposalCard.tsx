import { useState } from 'react'
import { Bookmark, GitPullRequest } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { CommunityPullRequest } from '../../../../shared/community-catalog'
import type { CommunityFeature } from '../../../../shared/community-features'
import { CommunityChangeCard } from './CommunityChangeCard'

export function CommunityProposalCard({
  pr,
  feature,
  onOpen,
  onSave
}: {
  pr: CommunityPullRequest
  feature?: CommunityFeature
  onOpen: () => void
  onSave: () => Promise<unknown>
}): React.JSX.Element {
  const t = useTranslate()
  const [saving, setSaving] = useState(false)
  return (
    <CommunityChangeCard
      number={pr.number}
      title={pr.displayTitle}
      label={`${pr.title} #${pr.number}`}
      category={`${pr.area} · ${pr.kind}`}
      metadata={`#${pr.number} · @${pr.author}`}
      imageUrls={pr.imageUrls}
      imageAlt={t('community.authorImage', 'Image linked by the PR author')}
      emptyPreview={
        <>
          <GitPullRequest className="size-8" />
          <span className="text-xs">{t('community.codeProposal', 'Code proposal')}</span>
        </>
      }
      badge={
        feature?.visit &&
        (feature.visit.headSha === pr.headSha
          ? t('community.viewed', 'Viewed')
          : t('community.updated', 'Updated since visit'))
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
