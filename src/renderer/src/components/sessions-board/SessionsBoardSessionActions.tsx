import { PanelTopOpen, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  aiVaultSessionResumeBlockedReason,
  aiVaultSessionResumeLabel
} from '../right-sidebar/ai-vault-session-resume'
import { aiVaultWorktreeJumpTooltip } from '../right-sidebar/ai-vault-session-worktree'
import type { SessionsBoardCardAvailability } from './sessions-board-card-availability'

/**
 * Go to where this session ran, and pick it back up there — the panel's two resting row
 * buttons, shared by the card and the conversation overlay.
 *
 * Why it carries no hover or pointer-events classes: the card decides when these appear (its
 * cluster reveals on hover), the overlay shows them always. Baking the reveal in here would
 * make one of the two wrong.
 */
export function SessionsBoardSessionActions({
  availability,
  onJump,
  onResume
}: {
  availability: SessionsBoardCardAvailability | null
  onJump: () => void
  onResume: () => void
}): React.JSX.Element {
  const worktreeInfo = availability?.worktreeInfo ?? null
  const jumpWorktreeId = availability?.jumpWorktreeId ?? null
  const jumpDisabled = !jumpWorktreeId
  // The tooltip is the reason when the action is refused and the action's name when it is
  // offered, which is what the panel's jump affordance already does.
  const jumpLabel = aiVaultWorktreeJumpTooltip(worktreeInfo)

  const resumeDisabled = availability?.resumeDisabled ?? true
  const resumeLabel =
    aiVaultSessionResumeBlockedReason({
      worktreeInfo,
      resumeDisabled,
      resumeBlocked: availability?.resumeBlocked ?? true
    }) ??
    aiVaultSessionResumeLabel({
      usesSessionWorktree: true,
      worktreeId: availability?.resumeWorktreeId ?? null
    })

  return (
    <>
      <ActionButton
        testId="sessions-board-card-jump"
        label={jumpLabel}
        disabled={jumpDisabled}
        onClick={onJump}
      >
        <PanelTopOpen className="size-3.5" />
      </ActionButton>
      <ActionButton
        testId="sessions-board-card-resume"
        label={resumeLabel}
        disabled={resumeDisabled}
        onClick={onResume}
      >
        <Play className="size-3.5" />
      </ActionButton>
    </>
  )
}

/**
 * A disabled `Button` is `pointer-events-none`, so it can never open its own tooltip — the
 * span is the trigger. The reason also rides on `aria-label`, which keeps it readable to a
 * screen reader and assertable without a hover.
 */
function ActionButton({
  testId,
  label,
  disabled,
  onClick,
  children
}: {
  testId: string
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={disabled}
            aria-label={label}
            onClick={onClick}
            data-testid={testId}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
