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
  const label =
    location.kind === 'worktree' && location.branch
      ? t('components.native-chat.workingLocation.inBranch', 'Working in {{name}} ({{branch}})', {
          name: location.displayName,
          branch: location.branch
        })
      : t('components.native-chat.workingLocation.in', 'Working in {{name}}', {
          name: location.displayName
        })
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 pl-2 text-xs text-muted-foreground"
      data-native-chat-working-location={location.kind}
    >
      <FolderGit2 className="size-3 shrink-0" />
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="min-w-0 truncate">{label}</span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {location.path}
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
