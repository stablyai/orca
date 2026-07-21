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
        {/* Why no disabled fallback item: with no fresh agent there is nothing to
            act on, and the pet is a ~48px sprite — an unusable row is pure noise
            at that size. No target, no menu. */}
        {agentTarget ? (
          <ContextMenuContent>
            <ContextMenuItem onSelect={jumpToAgent}>
              {translate('auto.components.pet.PetOverlay.jumpToAgent', 'Go to {{value0}}', {
                value0: agentLabel
              })}
            </ContextMenuItem>
            {/* Same no-dead-rows rule as above: canAsk is false only when the
                target's paneKey will not resolve to a pane, and an ask that
                cannot be addressed must not be offered. */}
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
          </ContextMenuContent>
        ) : null}
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
