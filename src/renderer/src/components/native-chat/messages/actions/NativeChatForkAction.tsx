import { Bot, GitBranchPlus, Loader2, PanelTop } from 'lucide-react'
import { NativeChatForkIcon } from './NativeChatForkIcon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatForkRowAction } from './use-native-chat-fork'

const FORK_BUTTON_CLASS =
  'flex size-6 shrink-0 items-center justify-center rounded-md text-chat-foreground-faint transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:opacity-50'

/** A response's one Fork button: it opens the Fork window, through a menu of presets where the host
 *  can fork into a new worktree. */
export function NativeChatForkAction({
  itemId,
  fork
}: {
  itemId: string
  fork: NativeChatForkRowAction
}) {
  const t = useTranslate()
  const label = t('components.native-chat.fork.action', 'Fork from this response')
  // Disabled while support is still being learned; an unoffered row keeps an empty slot of this size.
  const disabledReason =
    fork.pendingItemId !== null
      ? t('components.native-chat.fork.pending', 'Forking this chat…')
      : fork.support.kind === 'unknown'
        ? t('components.native-chat.fork.checking', 'Checking whether this chat can fork…')
        : null
  const openWorktreeFork = fork.openWorktreeFork
  const icon =
    fork.pendingItemId === itemId ? (
      <Loader2 className="size-3.5 animate-spin" />
    ) : (
      <NativeChatForkIcon />
    )
  const tooltip =
    disabledReason ??
    (openWorktreeFork
      ? t(
          'components.native-chat.fork.windowTooltip',
          'Fork from this response: choose the host, workspace and agent, or press Enter for a new tab here.'
        )
      : t(
          'components.native-chat.fork.tooltip',
          'Fork from this response. The new chat includes this whole response, up to the end of its turn.'
        ))
  if (!openWorktreeFork || !fork.worktreeForkOffered || disabledReason !== null) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={FORK_BUTTON_CLASS}
            aria-label={label}
            aria-description={disabledReason ?? undefined}
            aria-disabled={disabledReason !== null}
            onClick={() => {
              if (disabledReason !== null) {
                return
              }
              if (openWorktreeFork) {
                openWorktreeFork(itemId, 'tab')
              } else {
                void fork.request(itemId)
              }
            }}
          >
            {icon}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {tooltip}
        </TooltipContent>
      </Tooltip>
    )
  }
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button type="button" className={FORK_BUTTON_CLASS} aria-label={label}>
              {icon}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {tooltip}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => openWorktreeFork(itemId, 'tab')}>
          <PanelTop className="size-3.5" />
          {t('components.native-chat.fork.menuTabWindow', 'In a new tab…')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openWorktreeFork(itemId, 'worktree')}>
          <GitBranchPlus className="size-3.5" />
          {t('components.native-chat.fork.menuWorktree', 'Into a new worktree…')}
        </DropdownMenuItem>
        {fork.subagentOffered === false ? null : (
          <DropdownMenuItem onSelect={() => openWorktreeFork(itemId, 'subagent')}>
            <Bot className="size-3.5" />
            {t('components.native-chat.fork.menuSubagent', 'As a background subagent…')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
