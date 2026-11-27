import React from 'react'
import { CircleAlert, LoaderCircle } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import type { WorktreeCardController } from '../controller/use-worktree-card-controller'
import type { AutoNameFailure } from './use-auto-name-failure'

/** The row's grey mark for a failed auto-name; the row's hover card carries the reason and actions. */
export function AutoNameFailedIndicator({
  card,
  failure,
  onPointerDown
}: {
  card: WorktreeCardController
  failure: AutoNameFailure
  onPointerDown: React.PointerEventHandler<HTMLButtonElement>
}): React.JSX.Element {
  const t = useTranslate()
  // The mark opens the row's one hover card; a popup of its own would sit under that card.
  const openCard = (): void => card.detailsHoverControl.handleHoverOpenChange(true)
  return (
    <button
      type="button"
      aria-label={
        failure.retrying
          ? t('auto.components.sidebar.AutoNameFailed.naming', 'Naming this workspace…')
          : t('auto.components.sidebar.AutoNameFailed.title', 'Couldn’t auto-name')
      }
      onPointerDown={onPointerDown}
      onPointerEnter={openCard}
      onFocus={openCard}
      onClick={(event) => {
        event.stopPropagation()
        openCard()
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      className="inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/70 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      {failure.retrying ? (
        <LoaderCircle className="size-3 animate-spin" aria-hidden />
      ) : (
        <CircleAlert className="size-3" aria-hidden />
      )}
    </button>
  )
}
