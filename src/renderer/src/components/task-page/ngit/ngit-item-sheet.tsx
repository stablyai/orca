import * as VisuallyHidden from 'radix-ui/visually-hidden'
import { LoaderCircle, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle
} from '@/components/ui/sheet'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { ngitShortId, type NgitWorkItem } from '../../../../../shared/ngit/ngit-work-item-types'
import { NgitStateIcon, ngitStateLabel, ngitTypeLabel } from './ngit-work-item-state'
import { useNgitItemDetails } from './use-ngit-item-details'
import { NgitConversation } from './ngit-conversation'
import { NgitItemActions } from './ngit-item-actions'

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
  const state = useNgitItemDetails(item, repo, onChanged)
  const { details, error, loading, refresh } = state
  // A reread after a write is newer than the list row.
  const shown = details?.item ?? item
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
          <NgitConversation details={details} error={error} loading={loading} />
        </div>
        <footer className="flex-none border-t border-border/40 px-5 py-3">
          <NgitItemActions item={item} state={state} onUse={onUse} />
        </footer>
      </SheetContent>
    </Sheet>
  )
}
