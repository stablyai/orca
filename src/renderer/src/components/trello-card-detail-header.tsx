import { ArrowRight, ChevronLeft, ChevronRight, Clipboard, Link, LoaderCircle } from 'lucide-react'
import type { TrelloCard } from '../../../shared/trello-types'
import { TrelloIcon } from '@/components/icons/TrelloIcon'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

type TrelloCardDetailHeaderProps = {
  card: TrelloCard
  loading: boolean
  backLabel?: string
  onClose: () => void
  onCopyUrl: () => void
  onCopyShortLink: () => void
  onStartWorkspace: () => void
}

export function TrelloCardDetailHeader({
  card,
  loading,
  backLabel,
  onClose,
  onCopyUrl,
  onCopyShortLink,
  onStartWorkspace
}: TrelloCardDetailHeaderProps): React.JSX.Element {
  return (
    <header className="flex h-[61px] flex-none items-center justify-between gap-4 border-b border-border/60 px-5">
      <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="-ml-2 shrink-0 gap-1.5"
          aria-label={backLabel ?? 'Back to Trello list'}
        >
          <ChevronLeft className="size-4" />
          {backLabel ?? 'Trello list'}
        </Button>
        <TrelloIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium text-foreground">{card.boardName ?? 'Trello'}</span>
        <ChevronRight className="size-3.5 shrink-0" />
        <span className="shrink-0">Cards</span>
        {card.listName ? (
          <>
            <ChevronRight className="size-3.5 shrink-0" />
            <span className="max-w-[160px] truncate">{card.listName}</span>
          </>
        ) : null}
        <ChevronRight className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate font-medium text-foreground">{card.name}</span>
        {loading ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" /> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={onCopyUrl} aria-label="Copy Trello URL">
              <Link className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            Copy URL
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onCopyShortLink}
              aria-label="Copy Trello short link"
            >
              <Clipboard className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            Copy short link
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onStartWorkspace}
              aria-label="Start workspace from Trello card"
            >
              <ArrowRight className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            Start workspace
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  )
}
