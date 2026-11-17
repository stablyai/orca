import { FolderGit2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatWorkingLocation } from './native-chat-working-location'

/** The header text for where a chat's agent works, with Open for a worktree. */
export function NativeChatWorkingLocationLabel({
  location,
  opening,
  onOpen
}: {
  location: NativeChatWorkingLocation
  opening: boolean
  onOpen: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const label = t('components.native-chat.workingLocation.in', 'Working in {{name}}', {
    name: location.displayName
  })
  // The branch only qualifies the name, so it stays in the tooltip with the path.
  const branch = location.kind === 'worktree' ? location.branch : null
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 pl-2 text-xs text-muted-foreground"
      data-native-chat-working-location={location.kind}
    >
      <FolderGit2 className="size-3 shrink-0" />
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="min-w-0 truncate rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {branch ? <div>{branch}</div> : null}
          <div>{location.path}</div>
        </TooltipContent>
      </Tooltip>
      {location.kind === 'worktree' ? (
        <Button
          type="button"
          variant="pane-title"
          size="xs"
          className="shrink-0"
          disabled={opening}
          data-native-chat-working-location-open=""
          onClick={(event) => {
            event.stopPropagation()
            onOpen()
          }}
        >
          {t('components.native-chat.workingLocation.open', 'Open worktree')}
        </Button>
      ) : null}
    </div>
  )
}
