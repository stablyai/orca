import { useContext } from 'react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatForkContext } from './native-chat-fork-context'
import { NativeChatForkIcon } from './NativeChatForkIcon'

const BUTTON_CLASS =
  'flex size-6 shrink-0 items-center justify-center rounded-md text-chat-foreground-faint transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:opacity-50'

/** Fork from one of your messages: the chat up to just before it, with the message as an unsent draft. */
export function NativeChatUserForkAction({
  itemId,
  text
}: {
  itemId: string
  text: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const fork = useContext(NativeChatForkContext)
  const forkPointBefore = fork?.forkPointBefore
  if (!fork || !forkPointBefore || !text.trim()) {
    return null
  }
  const label = t('components.native-chat.fork.fromMessage', 'Fork from here')
  const disabledReason =
    fork.pendingItemId !== null
      ? t('components.native-chat.fork.pending', 'Forking this chat…')
      : fork.support.kind === 'unknown'
        ? t('components.native-chat.fork.checking', 'Checking whether this chat can fork…')
        : null
  const tooltip =
    disabledReason ??
    t(
      'components.native-chat.fork.fromMessageTooltip',
      'Fork from here: a new chat up to this message, with it as an unsent draft you can edit.'
    )
  // No earlier response means there is nothing to copy; say so instead of forking an empty chat.
  const start = (run: (throughItemId: string) => void): void => {
    const throughItemId = forkPointBefore(itemId)
    if (!throughItemId) {
      toast.message(
        t(
          'components.native-chat.fork.fromMessageNothing',
          'There’s no response before this message to fork from.'
        )
      )
      return
    }
    run(throughItemId)
  }
  const inTab = (): void =>
    start((through) => void fork.request(through, undefined, undefined, text))
  const openWorktreeFork = fork.openWorktreeFork
  const button = (
    <button
      type="button"
      className={BUTTON_CLASS}
      aria-label={label}
      aria-description={disabledReason ?? undefined}
      aria-disabled={disabledReason !== null}
      onClick={openWorktreeFork || disabledReason !== null ? undefined : inTab}
    >
      <NativeChatForkIcon />
    </button>
  )
  if (!openWorktreeFork || disabledReason !== null) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
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
          <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {tooltip}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={inTab}>
          {t('components.native-chat.fork.fromMessageTab', 'Edit in a new tab')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => start((through) => openWorktreeFork(through, 'worktree', text))}
        >
          {t('components.native-chat.fork.fromMessageWorktree', 'Edit in a new worktree…')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
