import { Globe, Mic, MessageSquare, Package, ArrowUpRight } from 'lucide-react'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { useTranslate } from '@/i18n/use-translate'
import { communityReleaseHighlights } from './community-release-highlights'

export function CommunityReleaseHighlights({
  body,
  onOpen
}: {
  body: string
  onOpen: (number: number) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const highlights = communityReleaseHighlights(body)
  if (!highlights.length) {
    return null
  }
  return (
    <section
      aria-label={t('community.releaseHighlights', 'Release highlights')}
      className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"
    >
      {highlights.map((highlight) => {
        const Icon = /browser|page|web/i.test(highlight.title)
          ? Globe
          : /voice|dictat|microphone/i.test(highlight.title)
            ? Mic
            : /chat|agent|conversation/i.test(highlight.title)
              ? MessageSquare
              : Package
        return (
          <article
            key={`${highlight.title}-${highlight.body}`}
            className="overflow-hidden rounded-xl border border-border bg-card text-card-foreground"
          >
            <div className="flex h-28 items-center justify-center border-b border-border bg-muted/40">
              <Icon className="size-8 text-muted-foreground" />
            </div>
            <div className="space-y-3 p-4">
              <CommentMarkdown className="text-sm font-semibold" content={highlight.title} />
              <CommentMarkdown
                className="line-clamp-5 text-xs text-muted-foreground"
                content={highlight.body}
              />
              {highlight.prs.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {highlight.prs.map((number) => (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-md text-xs underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring"
                      key={number}
                      onClick={() => onOpen(number)}
                    >
                      #{number}
                      <ArrowUpRight className="size-3" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </article>
        )
      })}
    </section>
  )
}
