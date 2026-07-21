import { useCallback, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { formatAgentTypeLabel } from '@/lib/agent-status'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { usePetAgentJump } from './pet-agent-jump'
import { usePetAgentAsk } from './pet-agent-ask'
import { usePetAgentSpawn } from './pet-agent-spawn'
import { PetAskDialog } from './PetAskDialog'

/**
 * Right-click surface for the pet.
 *
 * Wraps the pet's own (pointer-events-auto) node via `asChild` so the menu's hit
 * area is exactly the sprite's grab area — the overlay's outer boxes stay
 * click-through, and app chrome behind the pet keeps working.
 */
export function PetContextMenu({
  entries,
  children
}: {
  entries: readonly AgentStatusEntry[]
  children: React.ReactNode
}): React.JSX.Element {
  const { agentTarget, jumpToAgent } = usePetAgentJump(entries)
  const { canAsk, askAgent } = usePetAgentAsk(agentTarget)
  const { canSpawn, spawnOmpAgent } = usePetAgentSpawn()
  const [askOpen, setAskOpen] = useState(false)

  const agentLabel = formatAgentTypeLabel(agentTarget?.agentType)

  const submitAsk = useCallback(
    (prompt: string): void => {
      void askAgent(prompt)
    },
    [askAgent]
  )

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        {/* The menu ALWAYS renders. An earlier version omitted it entirely when
            there was no fresh agent, reasoning that an unusable row is noise on a
            48px sprite. That was wrong in the field: a pet that silently does
            nothing on right-click is indistinguishable from a pet whose
            right-click is broken, and it cost a real "the feature is dead" bug
            report against a working build. A disabled row that says why is the
            cheapest possible answer to "is this thing on?". */}
        <ContextMenuContent>
          {agentTarget ? (
            <>
              <ContextMenuItem onSelect={jumpToAgent}>
                {translate('auto.components.pet.PetOverlay.jumpToAgent', 'Go to {{value0}}', {
                  value0: agentLabel
                })}
              </ContextMenuItem>
              {canAsk ? (
                <ContextMenuItem
                  onSelect={() => {
                    // Why deferred to a dialog rather than opened inline: onSelect
                    // fires as the menu unmounts, and mounting an input in that
                    // same tick loses the focus race with the menu's restore.
                    setAskOpen(true)
                  }}
                >
                  {translate('auto.components.pet.PetOverlay.askAgent', 'Ask {{value0}}…', {
                    value0: agentLabel
                  })}
                </ContextMenuItem>
              ) : null}
            </>
          ) : (
            /* The empty state is an offer, not an apology. With no agent
               reporting, the useful thing a pet can do is get one — so the row
               spawns its assistant rather than explaining why it can't help.
               Falls back to a disabled explanation only when there is no active
               worktree to launch into, since an agent must land somewhere and
               guessing a repo the user isn't looking at is worse than nothing. */
            canSpawn ? (
              <ContextMenuItem onSelect={spawnOmpAgent}>
                {translate('auto.components.pet.PetOverlay.spawnOmpAgent', 'Give me an assistant…')}
              </ContextMenuItem>
            ) : (
              <ContextMenuItem disabled>
                {translate(
                  'auto.components.pet.PetOverlay.noWorktree',
                  'Open a workspace first'
                )}
              </ContextMenuItem>
            )
          )}
        </ContextMenuContent>
      </ContextMenu>
      <PetAskDialog
        open={askOpen}
        agentLabel={agentLabel}
        onOpenChange={setAskOpen}
        onSubmit={submitAsk}
      />
    </>
  )
}

export default PetContextMenu
