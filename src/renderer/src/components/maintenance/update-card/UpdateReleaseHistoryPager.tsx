import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { UpdateReleaseHistory } from '../../../../../shared/updater/update-status-types'
import CommentMarkdown from '@/components/comment-markdown/CommentMarkdown'
import type { CommentMarkdownLinkClickHandler } from '@/components/comment-markdown/comment-markdown-element-renderers'
import { Button } from '../../ui/button'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { cn } from '@/lib/class-names'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'

// Intl formatter caches key on option identity, so this must be a module constant.
const RELEASE_DATE_FORMAT: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }

// Compact markdown renders paragraphs and headings inline; give release notes block flow here only.
const NOTES_CLASS_NAME = cn(
  'scrollbar-sleek max-h-40 overflow-y-auto text-xs leading-relaxed text-muted-foreground',
  '[&_.comment-md-p]:block [&_.comment-md-h]:block [&>*+*]:mt-1.5',
  '[&_.comment-md-h]:mt-3 [&_.comment-md-h]:leading-snug [&_.comment-md-h]:text-foreground [&_.comment-md-h:first-child]:mt-0',
  '[&_.comment-md-h1]:text-[13px] [&_.comment-md-h2]:text-[13px]'
)

// Release notes decorate headings and bullets with raw-HTML mascot images, which compact
// markdown would show as alt-text links; they carry no content, so drop them.
function stripInlineHtmlImages(notes: string): string {
  return notes.replace(/<img\b[^>]*>/gi, '')
}

const openNotesLink: CommentMarkdownLinkClickHandler = (event, href) => {
  event.preventDefault()
  if (href) {
    openAppHttpLink(href, { event })
  }
}

/** Pages through every release between the installed build and the update, newest first. */
export function UpdateReleaseHistoryPager({
  history
}: {
  history: UpdateReleaseHistory
}): React.JSX.Element | null {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const { releases } = history
  const newestVersion = releases[0]?.version
  // A newer update replaces the history; restart at its newest release.
  const [page, setPage] = useState({ newestVersion, index: 0 })
  const pageIndex =
    page.newestVersion === newestVersion ? Math.min(page.index, releases.length - 1) : 0
  const setIndex = (index: number): void => setPage({ newestVersion, index })
  const release = releases[pageIndex]
  if (!release) {
    return null
  }
  const publishedAt = release.publishedAt ? Date.parse(release.publishedAt) : Number.NaN
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        {t('updates.releaseHistory.summary', "You're on v{{installed}} · {{count}} new releases", {
          installed: history.installedVersion,
          count: history.newerReleaseCount,
          defaultValue_one: "You're on v{{installed}} · {{count}} new release"
        })}
      </p>
      <div className="flex min-w-0 flex-col gap-1.5 rounded-md border p-2.5">
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-xs">
            <span className="font-semibold">v{release.version}</span>
            {Number.isFinite(publishedAt) && (
              <span className="text-muted-foreground">
                {' · '}
                {uiDateTimeFormat(RELEASE_DATE_FORMAT, intlLocale).format(publishedAt)}
              </span>
            )}
          </p>
          {releases.length > 1 && (
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={pageIndex === 0}
                onClick={() => setIndex(pageIndex - 1)}
                aria-label={t('updates.releaseHistory.newer', 'Newer release')}
              >
                <ChevronLeft />
              </Button>
              <span className="text-2xs tabular-nums text-muted-foreground">
                {t('updates.releaseHistory.position', '{{current}} of {{total}}', {
                  current: pageIndex + 1,
                  total: releases.length
                })}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={pageIndex === releases.length - 1}
                onClick={() => setIndex(pageIndex + 1)}
                aria-label={t('updates.releaseHistory.older', 'Older release')}
              >
                <ChevronRight />
              </Button>
            </div>
          )}
        </div>
        {release.notes ? (
          <CommentMarkdown
            key={release.version}
            content={stripInlineHtmlImages(release.notes)}
            onLinkClick={openNotesLink}
            className={NOTES_CLASS_NAME}
          />
        ) : null}
        <button
          type="button"
          className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={(event) => openAppHttpLink(release.releaseUrl, { event })}
        >
          {t('updates.releaseHistory.viewOnGitHub', 'View on GitHub')}
        </button>
      </div>
    </div>
  )
}
