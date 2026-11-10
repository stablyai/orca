import { GitBranchPlus, GitFork, Loader2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatForkRowAction } from './use-native-chat-fork'

/** A response's forks: a new tab beside this chat, and a new worktree where the host can. */
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
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-chat-foreground-faint transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:opacity-50"
            aria-label={label}
            aria-description={disabledReason ?? undefined}
            aria-disabled={disabledReason !== null}
            onClick={() => {
              if (disabledReason === null) {
                void fork.request(itemId)
              }
            }}
          >
            {fork.pendingItemId === itemId ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <GitFork className="size-3.5" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {disabledReason ??
            t(
              'components.native-chat.fork.tooltip',
              'Fork from this response. The new chat includes this whole response, up to the end of its turn.'
            )}
        </TooltipContent>
      </Tooltip>
      {openWorktreeFork ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-chat-foreground-faint transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:opacity-50"
              aria-label={t(
                'components.native-chat.fork.worktree.action',
                'Fork into a new worktree'
              )}
              aria-description={disabledReason ?? undefined}
              aria-disabled={disabledReason !== null}
              onClick={() => {
                if (disabledReason === null) {
                  openWorktreeFork(itemId)
                }
              }}
            >
              <GitBranchPlus className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {disabledReason ??
              t(
                'components.native-chat.fork.worktree.tooltip',
                'Fork into a new worktree. Its chat includes this whole response, up to the end of its turn.'
              )}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </>
  )
}
