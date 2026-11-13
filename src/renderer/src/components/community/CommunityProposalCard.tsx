import { useState } from 'react'
import { Bookmark, GitPullRequest, ImageIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { useTranslate } from '@/i18n/use-translate'
import type { CommunityPullRequest } from '../../../../shared/community-catalog'
import type { CommunityFeature } from '../../../../shared/community-features'
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
    <Card size="list" className="overflow-hidden" data-proposal={pr.number}>
      <button
        type="button"
        className="group block text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onOpen}
        aria-label={`${pr.title} #${pr.number}`}
      >
        <div className="relative flex h-48 items-center justify-center border-b border-border bg-muted/40 p-3">
          {pr.imageUrls[0] ? (
            <img
              src={pr.imageUrls[0]}
              alt={t('community.authorImage', 'Image linked by the PR author')}
              loading="lazy"
              referrerPolicy="no-referrer"
              className="size-full object-contain"
            />
          ) : (
            <div className="flex flex-col items-center gap-3 text-muted-foreground">
              <GitPullRequest className="size-8" />
              <span className="text-xs">{t('community.codeProposal', 'Code proposal')}</span>
            </div>
          )}
          {feature?.visit && (
            <Badge variant="secondary" className="absolute top-3 left-3">
              {feature.visit.headSha === pr.headSha
                ? t('community.viewed', 'Viewed')
                : t('community.updated', 'Updated since visit')}
            </Badge>
          )}
          {pr.imageUrls.length > 0 && (
            <Badge variant="secondary" className="absolute right-3 bottom-3">
              <ImageIcon className="size-3" />
              {pr.imageUrls.length}
            </Badge>
          )}
        </div>
        <div className="p-4">
          <p className="text-2xs text-muted-foreground">
            {pr.area} · {pr.kind}
          </p>
          <h3 className="mt-2 min-h-10 text-sm font-semibold leading-snug group-hover:underline">
            {pr.displayTitle}
          </h3>
          <p className="mt-3 text-xs text-muted-foreground">
            #{pr.number} · @{pr.author}
          </p>
        </div>
      </button>
      <div className="mx-4 flex items-center justify-between border-t border-border py-2">
        <span className="text-2xs text-muted-foreground">
          {pr.state === 'merged'
            ? t('community.mergedSource', 'Merged into source')
            : pr.state === 'closed'
              ? t('community.closed', 'Closed')
              : pr.isDraft
                ? t('community.draft', 'Draft · Not merged')
                : t('community.unmerged', 'Not merged into official Orca')}
        </span>
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
      </div>
    </Card>
  )
}
