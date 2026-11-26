import { useState } from 'react'
import * as VisuallyHidden from 'radix-ui/visually-hidden'
import { ExternalLink, LoaderCircle, RefreshCw, Send, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle
} from '@/components/ui/sheet'
import CommentMarkdown from '@/components/comment-markdown/CommentMarkdown'
import { ImeTextarea } from '@/lib/text-input/ime/ime-text-field'
import { isScreenSubmitShortcut } from '@/lib/keyboard/screen-submit-shortcut'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { ngitShortId, type NgitWorkItem } from '../../../../../shared/ngit/ngit-work-item-types'
import { NgitStateIcon, ngitStateLabel, ngitTypeLabel } from './ngit-work-item-state'
import { NgitStatusActions } from './ngit-status-actions'
import { useNgitItemDetails } from './use-ngit-item-details'

export function NgitItemSheet({
  item,
  repo,
  onClose,
  onChanged,
  onUse
}: {
  item: NgitWorkItem
  repo: Repo
  onClose: () => void
  onChanged: () => void
  /** Absent where the item already has its workspace. */
  onUse?: (item: NgitWorkItem) => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const { details, viewer, error, loading, writing, refresh, publish } = useNgitItemDetails(
    item,
    repo,
    onChanged
  )
  const [comment, setComment] = useState('')
  // A reread after a write is newer than the list row.
  const shown = details?.item ?? item
  const cannotSign = viewer !== null && viewer.account === null
  const canComment = comment.trim().length > 0 && !writing && !cannotSign
  const submitComment = (): void => {
    void publish((api) => api.addComment(item.type, item.eventId, comment)).then((published) => {
      if (published) {
        setComment('')
      }
    })
  }
  const timestamp = (value: string): string => new Date(value).toLocaleString(intlLocale)

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      {/* The sheet's own close control would overlap this header's actions. */}
      <SheetContent side="right" showCloseButton={false} className="w-full sm:max-w-2xl">
        <VisuallyHidden.Root>
          <SheetTitle>{shown.title}</SheetTitle>
          <SheetDescription>
            {t('components.taskPage.ngit.detailDescription', 'ngit work item detail')}
          </SheetDescription>
        </VisuallyHidden.Root>
        <header className="flex-none border-b border-border/40 py-4 pl-5 pr-[max(1.25rem,var(--window-controls-width,0px))]">
          <div className="flex items-start gap-3">
            <NgitStateIcon item={shown} className="mt-0.5 size-5 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-mono">{ngitShortId(shown.eventId)}</span>
                <span className="rounded-full border border-border/50 bg-muted/40 px-2 py-0.5 text-[10px] font-medium">
                  {ngitTypeLabel(shown)} · {ngitStateLabel(shown)}
                </span>
                <span>{shown.author}</span>
                <span>{timestamp(shown.createdAt)}</span>
              </div>
              <h2 className="mt-1.5 text-lg font-semibold leading-tight text-foreground">
                {shown.title}
              </h2>
              {shown.branchName || shown.headSha ? (
                <div className="mt-1.5 truncate font-mono text-xs text-muted-foreground">
                  {[shown.branchName, shown.headSha?.slice(0, 12)].filter(Boolean).join(' · ')}
                </div>
              ) : null}
              {shown.labels.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {shown.labels.map((label) => (
                    <span
                      key={label}
                      className="rounded-full border border-border/50 bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                    >
                      {label}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7"
                aria-label={t('components.taskPage.ngit.refresh', 'Refresh')}
                disabled={loading}
                onClick={refresh}
              >
                {loading ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
              </Button>
              <SheetClose asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-7"
                  aria-label={t('components.taskPage.ngit.close', 'Close')}
                >
                  <X className="size-3.5" />
                </Button>
              </SheetClose>
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 scrollbar-sleek">
          {error ? (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}
          {details?.body ? (
            <CommentMarkdown content={details.body} variant="document" />
          ) : details ? (
            <p className="text-sm text-muted-foreground">
              {t('components.taskPage.ngit.noDescription', 'No description.')}
            </p>
          ) : null}
          {details?.patches.map((patch) => (
            <details key={patch.id} className="rounded-md border border-border/50">
              <summary className="cursor-pointer truncate px-3 py-2 text-xs">
                <span className="font-mono text-muted-foreground">{patch.commit?.slice(0, 8)}</span>{' '}
                {patch.subject}
              </summary>
              <pre className="max-h-96 overflow-auto border-t border-border/50 px-3 py-2 font-mono text-xs scrollbar-sleek">
                {patch.content}
              </pre>
            </details>
          ))}
          {details ? (
            <section className="space-y-3 border-t border-border/40 pt-4">
              {details.comments.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t('components.taskPage.ngit.noComments', 'No comments yet.')}
                </p>
              ) : (
                details.comments.map((entry) => (
                  <article key={entry.id} className="rounded-md border border-border/50">
                    <div className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{entry.author}</span>
                      <span>{timestamp(entry.createdAt)}</span>
                      {entry.replyToId ? (
                        <span>{t('components.taskPage.ngit.reply', 'reply')}</span>
                      ) : null}
                    </div>
                    <div className="px-3 py-2">
                      <CommentMarkdown content={entry.body} />
                    </div>
                  </article>
                ))
              )}
            </section>
          ) : loading ? (
            <div className="flex items-center justify-center py-12">
              <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : null}
        </div>

        <footer className="flex-none space-y-3 border-t border-border/40 px-5 py-3">
          {cannotSign ? (
            <p className="text-xs text-muted-foreground">
              {viewer.cliInstalled
                ? t(
                    'components.taskPage.ngit.signInToWrite',
                    'Run ngit account login on this machine to comment or change status.'
                  )
                : t(
                    'components.taskPage.ngit.installToWrite',
                    'Install the ngit CLI on this machine to comment or change status.'
                  )}
            </p>
          ) : null}
          <div className="flex items-end gap-2">
            <ImeTextarea
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder={
                viewer?.account
                  ? t('components.taskPage.ngit.commentAs', 'Comment publicly as {{name}}…', {
                      name: viewer.account.name ?? viewer.account.npub.slice(0, 12)
                    })
                  : t('components.taskPage.ngit.commentPlaceholder', 'Comment…')
              }
              rows={2}
              disabled={writing || cannotSign}
              className="min-h-9 w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm shadow-xs focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/50"
              onKeyDown={(event) => {
                if (isScreenSubmitShortcut(event) && canComment) {
                  event.preventDefault()
                  submitComment()
                }
              }}
            />
            <Button size="sm" disabled={!canComment} onClick={submitComment} className="shrink-0">
              {writing ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Send className="size-3.5" />
              )}
              {t('components.taskPage.ngit.comment', 'Comment')}
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={(event) => openAppHttpLink(shown.url, { event })}
            >
              <ExternalLink className="size-3.5" />
              {t('components.taskPage.ngit.openInBrowser', 'Open on gitworkshop.dev')}
            </Button>
            <div className="flex flex-wrap items-center gap-2">
              <NgitStatusActions
                item={shown}
                disabled={writing || cannotSign}
                onAction={(action) =>
                  void publish((api) => api.setStatus(item.type, item.eventId, action))
                }
              />
              {onUse ? (
                <Button size="sm" onClick={() => onUse(shown)}>
                  {t('components.taskPage.ngit.createWorkspace', 'Create workspace')}
                </Button>
              ) : null}
            </div>
          </div>
        </footer>
      </SheetContent>
    </Sheet>
  )
}
