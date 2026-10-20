import { Copy, FileJson, FolderOpen, MoreHorizontal, TerminalSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { latestSessionConversationTurn } from '../right-sidebar/ai-vault-session-display'
import { useAiVaultSessionDisplayTitle } from '../right-sidebar/use-ai-vault-session-display-title'
import { SessionsBoardSessionActions } from './SessionsBoardSessionActions'
import type { SessionsBoardCardAvailability } from './sessions-board-card-availability'

// Why: the board shows a session's *identity* at a glance, so one card answers
// "which conversation is this" without opening it — the title, the tail of the
// conversation, and the folder it ran in.

// The two actions sit over the card, revealed on hover or keyboard focus — the same
// contract the Agent Session History row uses, so a dense board stays readable.
const ACTIONS_CLUSTER_CLASS = cn(
  'absolute right-1.5 top-1.5 flex items-center gap-0.5 transition-opacity',
  'can-hover:pointer-events-none can-hover:opacity-0 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100',
  'group-hover/card:pointer-events-auto group-hover/card:opacity-100',
  'group-focus-within/card:pointer-events-auto group-focus-within/card:opacity-100'
)

/** The last path segment of a cwd, tolerating either separator on any host. */
export function sessionFolderName(cwd: string): string {
  // Why the fallback: stripping a bare root's separator leaves nothing, and a card
  // footer reading "" would look like a missing cwd rather than the root it is.
  const trimmed = cwd.replace(/[\\/]+$/, '') || cwd
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return separator === -1 ? trimmed : trimmed.slice(separator + 1) || trimmed
}

export function SessionsBoardCard({
  session,
  availability,
  onOpen,
  onCopy,
  onJump,
  onResume
}: {
  session: AiVaultSession
  availability: SessionsBoardCardAvailability | null
  onOpen: () => void
  onCopy: (text: string) => void
  onJump: () => void
  onResume: () => void
}): React.JSX.Element {
  const title = useAiVaultSessionDisplayTitle(session)
  const latestTurn = latestSessionConversationTurn(session)
  const updatedAt = session.updatedAt ?? session.modifiedAt
  const folder = session.cwd ? sessionFolderName(session.cwd) : null
  const showCopyResumeCommand =
    availability?.canCopyResumeCommand === true && Boolean(session.resumeCommand)

  return (
    <div className="group/card relative">
      {/* The overlay's only opener, and the only element these actions are not nested inside:
          buttons cannot contain buttons, so the controls are siblings that overlay the card. */}
      <button
        type="button"
        onClick={onOpen}
        data-testid="sessions-board-card"
        className={cn(
          'flex w-full flex-col gap-1.5 rounded-lg border border-border/60 bg-card p-2.5 text-left transition-colors',
          'hover:border-border hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
        )}
      >
        <span className="flex items-start gap-1.5 pr-18">
          <AgentIcon agent={session.agent} size={12} />
          <span className="line-clamp-2 min-w-0 flex-1 text-xs font-medium leading-snug text-foreground">
            {title || translate('sessionsBoard.card.untitled', 'Untitled session')}
          </span>
        </span>

        {latestTurn ? (
          <span className="line-clamp-2 text-2xs leading-4 text-muted-foreground/80">
            {latestTurn.text}
          </span>
        ) : null}

        <span className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
          <span className="shrink-0 tabular-nums">
            {translate('sessionsBoard.card.messageCount', '{{count}} msgs', {
              count: session.messageCount
            })}
          </span>
          <span className="shrink-0 text-muted-foreground/55">·</span>
          <span className="shrink-0">{formatUiRelativeTimeFromDate(updatedAt)}</span>
          {session.model ? (
            <>
              <span className="shrink-0 text-muted-foreground/55">·</span>
              <span className="min-w-0 truncate">{session.model}</span>
            </>
          ) : null}
        </span>

        {folder ? (
          <span className="flex min-w-0 items-center gap-1 text-2xs text-muted-foreground/70">
            <FolderOpen className="size-3 shrink-0" />
            <span className="truncate" title={session.cwd ?? undefined}>
              {folder}
            </span>
          </span>
        ) : null}
      </button>

      <div className={ACTIONS_CLUSTER_CLASS}>
        <SessionsBoardSessionActions
          availability={availability}
          onJump={onJump}
          onResume={onResume}
        />
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={translate('sessionsBoard.card.moreActions', 'More session actions')}
                >
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="left" sideOffset={4}>
              {translate('sessionsBoard.card.moreActions', 'More session actions')}
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-52">
            {showCopyResumeCommand ? (
              <DropdownMenuItem onSelect={() => onCopy(session.resumeCommand)}>
                <TerminalSquare />
                {translate('sessionsBoard.card.copyResume', 'Copy resume command')}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => onCopy(session.sessionId)}>
              <Copy />
              {translate('sessionsBoard.card.copySessionId', 'Copy session ID')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onCopy(session.filePath)}>
              <FileJson />
              {translate('sessionsBoard.card.copyTranscriptPath', 'Copy transcript path')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
