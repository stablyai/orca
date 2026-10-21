import { Goal, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

/** Marks the draft as a goal objective; hovering reveals that a click leaves goal mode. */
export function NativeChatComposerGoalChip(props: { onExit: () => void }): React.JSX.Element {
  // Not "Clear goal": that is the banner's action on the provider's goal, and this only leaves the mode.
  const exitLabel = translate('components.native-chat.goal.exitMode', 'Exit goal mode')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="xs"
          aria-label={exitLabel}
          onClick={props.onExit}
          className="group/goal-chip"
        >
          <Goal
            aria-hidden
            className="group-hover/goal-chip:hidden group-focus-visible/goal-chip:hidden"
          />
          <X
            aria-hidden
            className="hidden group-hover/goal-chip:block group-focus-visible/goal-chip:block"
          />
          {translate('components.native-chat.goal.chip', 'Goal')}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {exitLabel}
      </TooltipContent>
    </Tooltip>
  )
}
