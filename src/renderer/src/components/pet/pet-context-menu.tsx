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

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      {/* Why no disabled fallback item: with no fresh agent there is nothing to
          act on, and the pet is a ~48px sprite — an unusable row is pure noise
          at that size. No target, no menu. */}
      {agentTarget ? (
        <ContextMenuContent>
          <ContextMenuItem onSelect={jumpToAgent}>
            {translate('auto.components.pet.PetOverlay.jumpToAgent', 'Go to {{value0}}', {
              value0: formatAgentTypeLabel(agentTarget.agentType)
            })}
          </ContextMenuItem>
        </ContextMenuContent>
      ) : null}
    </ContextMenu>
  )
}

export default PetContextMenu
