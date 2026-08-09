import { MousePointerClick } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useRichMarkdownFollowLinks } from './rich-markdown-follow-links-state'

export function RichMarkdownFollowLinksHeaderButton(): React.JSX.Element | null {
  const followLinks = useRichMarkdownFollowLinks()
  if (!followLinks) {
    return null
  }
  const label = translate(
    'auto.components.editor.RichMarkdownFollowLinksHeaderButton.followLinksOnClick',
    'Follow links on click'
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={`flex-shrink-0 rounded p-1 transition-colors hover:bg-accent hover:text-foreground ${
            followLinks.active ? 'bg-accent text-foreground' : 'text-muted-foreground'
          }`}
          aria-label={label}
          aria-pressed={followLinks.active}
          onMouseDown={(event) => event.preventDefault()}
          onClick={followLinks.onToggle}
        >
          <MousePointerClick size={14} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
