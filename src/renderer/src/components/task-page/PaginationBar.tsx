import React from 'react'
import { getPageNumbers } from '@/components/task-page-pagination-page-numbers'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { ChevronLeft, LoaderCircle, ChevronRight } from 'lucide-react'
export function PaginationBar({
  currentPage,
  totalPages,
  loadingTarget,
  onPageChange
}: {
  currentPage: number
  totalPages: number
  loadingTarget: number | null
  onPageChange: (page: number) => void
}): React.JSX.Element {
  const pageNumbers = getPageNumbers(currentPage, totalPages)
  const btnClass =
    'inline-flex w-24 items-center justify-center gap-0.5 rounded-md px-2 py-1 text-sm text-muted-foreground transition hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40'
  const numClass = (page: number): string =>
    cn(
      'inline-flex size-8 items-center justify-center rounded-md text-sm transition',
      page === currentPage
        ? 'bg-primary text-primary-foreground font-medium'
        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
    )
  return (
    <nav
      aria-label={translate('auto.components.TaskPage.e65757a338', 'Pagination')}
      className="flex items-center justify-center gap-1 border-t border-border/50 px-4 py-3"
    >
      <button
        type="button"
        disabled={currentPage === 0 || loadingTarget !== null}
        onClick={() => onPageChange(currentPage - 1)}
        aria-label={translate('auto.components.TaskPage.6cd6b3ae6a', 'Previous page')}
        className={btnClass}
      >
        <ChevronLeft className="size-4" />
        {translate('auto.components.TaskPage.297a805b64', 'Previous')}
      </button>

      {pageNumbers.map((entry, idx) =>
        entry === 'ellipsis' ? (
          <span
            key={`ellipsis-${idx}`}
            aria-hidden
            className="inline-flex size-8 items-center justify-center text-sm text-muted-foreground"
          >
            {translate('auto.components.TaskPage.cd171f3391', '...')}
          </span>
        ) : (
          <button
            key={entry}
            type="button"
            disabled={loadingTarget !== null && loadingTarget !== entry}
            onClick={() => onPageChange(entry)}
            aria-label={translate('auto.components.TaskPage.ae859c816b', 'Page {{value0}}', {
              value0: entry + 1
            })}
            aria-current={entry === currentPage ? 'page' : undefined}
            className={numClass(entry)}
          >
            {loadingTarget === entry ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              entry + 1
            )}
          </button>
        )
      )}

      <button
        type="button"
        disabled={currentPage >= totalPages - 1 || loadingTarget !== null}
        onClick={() => onPageChange(currentPage + 1)}
        aria-label={translate('auto.components.TaskPage.0c8df28045', 'Next page')}
        className={btnClass}
      >
        {translate('auto.components.TaskPage.b73717af92', 'Next')}
        <ChevronRight className="size-4" />
      </button>
    </nav>
  )
}

// Why: hoisted to module scope so the type-guard predicate isn't re-allocated on every TaskPage render.
